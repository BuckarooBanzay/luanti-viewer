import {
    BufferAttribute, BufferGeometry, Box3, Color, Fog, Frustum, Group, Matrix4, Mesh, PerspectiveCamera, Scene,
    Vector3, WebGLRenderer
} from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { MapblockLoader, UNLOAD_MARGIN } from "./loader"
import { MAPBLOCK_SIZE, type ParsedMapblock } from "./mapblock"
import { MaterialManager } from "./materials"
import { createNeighborhood, MapblockMesher, type MeshBuffer } from "./mesh/mesher"
import { NodeRegistry } from "./mesh/nodes"
import { parseB3d } from "./models/b3d"
import type { Model } from "./models/model"
import { parseObj } from "./models/obj"
import { TextureCompositor, type RgbaImage } from "./texture/compositor"
import type { MapblockPosition, ViewerOptions } from "./types"
import { World } from "./world"

const SKY_COLOR = 0x8cbafa
/** parallel getMapblock / getMedia requests */
const CONCURRENCY = 16
/** unloaded mapblocks that are kept in memory, moving back and forth does not fetch them again (~16 kB each) */
const CACHE_SIZE = 512
/** time per frame spent on generating meshes (milliseconds) */
const MESH_BUDGET = 12
/** the pending mapblocks are sorted again once the camera was rotated by more than ~15 degrees (cosine) */
const REPRIORITIZE_DOT = 0.966
/** time between two updates of the fps widget (milliseconds) */
const FPS_INTERVAL = 500

/**
 * Converts the output of the mesher to a three.js geometry.
 * The engine uses a left-handed coordinate system, x is mirrored (and the winding reversed)
 * to get the same picture in the right-handed system of three.js.
 */
export function createGeometry(buffer: MeshBuffer): BufferGeometry {
    const count = buffer.vertexCount
    const positions = new Float32Array(buffer.positions)
    for (let i = 0; i < positions.length; i += 3) {
        positions[i] = -positions[i]!
    }
    const uvs = new Float32Array(buffer.uvs)
    for (let i = 1; i < uvs.length; i += 2) {
        uvs[i] = 1 - uvs[i]!
    }
    const indices = count > 65535 ? new Uint32Array(buffer.indices) : new Uint16Array(buffer.indices)
    for (let i = 0; i < indices.length; i += 3) {
        const b = indices[i + 1]!
        indices[i + 1] = indices[i + 2]!
        indices[i + 2] = b
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute("position", new BufferAttribute(positions, 3))
    geometry.setAttribute("uv", new BufferAttribute(uvs, 2))
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(buffer.colors), 3))
    geometry.setIndex(new BufferAttribute(indices, 1))
    geometry.computeBoundingSphere()
    return geometry
}

/** decodes an image with the browser */
async function decodeImage(blob: Blob): Promise<RgbaImage> {
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })
    try {
        const canvas = document.createElement("canvas")
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext("2d", { willReadFrequently: true })
        if (!context) {
            throw new Error("2d canvas is not available")
        }
        context.drawImage(bitmap, 0, 0)
        const { width, height, data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
        return { width, height, data }
    } finally {
        bitmap.close()
    }
}

/**
 * Renders a luanti scene into the given element.
 * The mapblocks between `minPos` and `maxPos` are loaded and rendered, with a `viewRange` only
 * the ones around the camera (they are loaded and unloaded while the camera moves).
 * The camera can be rotated (left mouse button), moved (right mouse button) and zoomed (mouse wheel).
 * All resources are released once the element is removed from the document.
 */
export function createView(element: HTMLElement, options: ViewerOptions): void {
    const container = document.createElement("div")
    container.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden"
    element.appendChild(container)

    const status = document.createElement("div")
    status.style.cssText = "position:absolute;left:8px;bottom:8px;padding:4px 8px;border-radius:4px;"
        + "font:12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);pointer-events:none"
    container.appendChild(status)
    let statusText: string | null = null
    const setStatus = (text: string) => {
        if (text !== statusText) {
            statusText = text
            status.textContent = text
            status.style.display = text ? "block" : "none"
        }
    }

    let fpsWidget: HTMLDivElement | null = null
    if (options.showFPS) {
        fpsWidget = document.createElement("div")
        fpsWidget.style.cssText = "position:absolute;right:8px;top:8px;padding:4px 8px;border-radius:4px;"
            + "font:12px/1.4 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.55);pointer-events:none"
        fpsWidget.textContent = "-- fps"
        container.appendChild(fpsWidget)
    }

    const renderer = new WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.domElement.style.display = "block"
    container.appendChild(renderer.domElement)

    const scene = new Scene()
    scene.background = new Color(SKY_COLOR)

    const viewRange = options.viewRange ?? Infinity
    const streaming = Number.isFinite(viewRange)
    if (!(viewRange > 0)) {
        throw new Error("viewRange has to be greater than 0")
    }
    const bounds = options.minPos && options.maxPos ? { min: options.minPos, max: options.maxPos } : null
    if (!streaming && !bounds) {
        throw new Error("minPos and maxPos are required without a viewRange")
    }

    // scene bounds in three.js coordinates (x is mirrored)
    let centerX = 0, centerY = 0, centerZ = 0, extent = Infinity
    if (bounds) {
        const sizeX = (bounds.max.x - bounds.min.x + 1) * MAPBLOCK_SIZE
        const sizeY = (bounds.max.y - bounds.min.y + 1) * MAPBLOCK_SIZE
        const sizeZ = (bounds.max.z - bounds.min.z + 1) * MAPBLOCK_SIZE
        centerX = -(bounds.min.x * MAPBLOCK_SIZE + sizeX / 2 - 0.5)
        centerY = bounds.min.y * MAPBLOCK_SIZE + sizeY / 2 - 0.5
        centerZ = bounds.min.z * MAPBLOCK_SIZE + sizeZ / 2 - 0.5
        extent = Math.max(sizeX, sizeY, sizeZ)
    }

    // with a view range the border of the loaded area is hidden by fog, the camera stays close to its target
    const fogFar = Math.max(viewRange - 1, 1) * MAPBLOCK_SIZE
    const maxDistance = streaming ? Math.min(extent * 4, fogFar * 0.5) : extent * 4
    const far = streaming ? (viewRange + UNLOAD_MARGIN + 2) * MAPBLOCK_SIZE : Math.max(extent * 8, 1000)
    if (streaming) {
        scene.fog = new Fog(SKY_COLOR, fogFar * 0.6, fogFar)
    }

    const camera = new PerspectiveCamera(60, 1, 0.1, far)
    const initialDistance = Math.min(extent, maxDistance)
    camera.position.set(
        centerX + initialDistance * 0.55, centerY + initialDistance * 0.45, centerZ - initialDistance * 0.55)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(centerX, centerY, centerZ)
    if (options.camera) {
        const { position, target } = options.camera
        camera.position.set(-position.x, position.y, position.z)
        controls.target.set(-target.x, target.y, target.z)
    }
    controls.enableDamping = true
    controls.zoomToCursor = true
    controls.maxDistance = maxDistance
    controls.update()

    const resize = () => {
        const width = Math.max(container.clientWidth, 1)
        const height = Math.max(container.clientHeight, 1)
        renderer.setSize(width, height)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    resize()

    const textures = new TextureCompositor(async name => {
        const blob = await options.getMedia(name)
        return blob ? decodeImage(blob) : null
    })
    const materials = new MaterialManager(textures)

    let disposed = false
    let wasConnected = false
    const dispose = () => {
        disposed = true
        renderer.setAnimationLoop(null)
        resizeObserver.disconnect()
        controls.dispose()
        loader.dispose()
        materials.dispose()
        renderer.dispose()
        container.remove()
    }

    const start = performance.now()
    let fpsFrames = 0
    let fpsStart = start
    renderer.setAnimationLoop(() => {
        // release everything once the view is removed from the document
        if (container.isConnected) {
            wasConnected = true
        } else if (wasConnected) {
            dispose()
            return
        }
        const now = performance.now()
        if (fpsWidget) {
            fpsFrames++
            if (now - fpsStart >= FPS_INTERVAL) {
                fpsWidget.textContent = `${Math.round(fpsFrames * 1000 / (now - fpsStart))} fps`
                fpsFrames = 0
                fpsStart = now
            }
        }
        materials.update((now - start) / 1000)
        controls.update()
        if (started) {
            updateLoader()
        }
        renderer.render(scene, camera)
    })

    const models = new Map<string, Promise<Model | null>>()
    const loadModel = (name: string): Promise<Model | null> => {
        let model = models.get(name)
        if (!model) {
            model = (async () => {
                const blob = await options.getMedia(name)
                if (!blob) {
                    console.warn(`[luanti-viewer] model not found: ${name}`)
                    return null
                }
                if (name.toLowerCase().endsWith(".obj")) {
                    return parseObj(await blob.text())
                }
                if (name.toLowerCase().endsWith(".b3d")) {
                    return parseB3d(await blob.arrayBuffer())
                }
                console.warn(`[luanti-viewer] unsupported model format: ${name}`)
                return null
            })().catch(e => {
                console.error(`[luanti-viewer] failed to load model '${name}'`, e)
                return null
            })
            models.set(name, model)
        }
        return model
    }

    const nodes = new NodeRegistry(async name => {
        try {
            return await options.getNodeDefinitions(name)
        } catch (e) {
            console.error(`[luanti-viewer] failed to load node definition '${name}'`, e)
            return null
        }
    }, materials)
    const world = new World(nodes)
    const mesher = new MapblockMesher(nodes)
    const neighborhood = createNeighborhood()

    // mapblocks in the view frustum are loaded first
    const frustum = new Frustum()
    const projection = new Matrix4()
    const blockBox = new Box3()
    const inFrustum = (pos: MapblockPosition) => {
        const x = pos.x * MAPBLOCK_SIZE - 0.5, y = pos.y * MAPBLOCK_SIZE - 0.5, z = pos.z * MAPBLOCK_SIZE - 0.5
        blockBox.min.set(-(x + MAPBLOCK_SIZE), y, z)
        blockBox.max.set(-x, y + MAPBLOCK_SIZE, z + MAPBLOCK_SIZE)
        return frustum.intersectsBox(blockBox)
    }

    const loader = new MapblockLoader<ParsedMapblock, Group | null>({
        viewRange,
        bounds,
        concurrency: CONCURRENCY,
        cacheSize: CACHE_SIZE,
        fetch: async pos => {
            const mapblock = await options.getMapblock(pos)
            if (!mapblock) {
                return null
            }
            // the node ids are resolved synchronously, the definitions and models have to be present
            await nodes.ensure(mapblock.nodeNames.values())
            await Promise.all([...mapblock.nodeNames.values()].map(async name => {
                const info = nodes.infos[nodes.getId(name)]!
                if (info.drawtype === "mesh" && info.def.mesh && !info.model) {
                    info.model = await loadModel(info.def.mesh)
                }
            }))
            return mapblock
        },
        store: (pos, mapblock) => world.set(pos, mapblock),
        unload: pos => world.delete(pos),
        mesh: pos => {
            try {
                world.fillNeighborhood(pos, neighborhood)
                const origin = { x: pos.x * MAPBLOCK_SIZE, y: pos.y * MAPBLOCK_SIZE, z: pos.z * MAPBLOCK_SIZE }
                const buffers = mesher.mesh(neighborhood, origin)
                if (buffers.size === 0) {
                    return null
                }
                const group = new Group()
                group.position.set(-origin.x, origin.y, origin.z)
                for (const [tile, buffer] of buffers) {
                    group.add(new Mesh(createGeometry(buffer), materials.getMaterial(tile)))
                }
                scene.add(group)
                return group
            } catch (e) {
                console.error(`[luanti-viewer] failed to mesh mapblock (${pos.x},${pos.y},${pos.z})`, e)
                return null
            }
        },
        unmesh: group => {
            if (group) {
                scene.remove(group)
                for (const child of group.children) {
                    (child as Mesh).geometry.dispose()
                }
            }
        },
        priority: streaming
            // visible mapblocks first, then by distance
            ? (pos, distance) => distance + (inFrustum(pos) ? 0 : viewRange + UNLOAD_MARGIN)
            // from the center outwards, top down
            : pos => Math.hypot(pos.x - sceneCenter.x, pos.z - sceneCenter.z) - pos.y * 1e-3
    })

    const blockOf = (coordinate: number) => Math.floor((coordinate + 0.5) / MAPBLOCK_SIZE)
    /** center of the scene in mapblocks, only used without a view range */
    const sceneCenter = bounds ? {
        x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z: (bounds.min.z + bounds.max.z) / 2
    } : { x: 0, y: 0, z: 0 }
    const direction = new Vector3()
    const lastDirection = new Vector3()

    /** follows the camera with the loaded range and generates pending meshes, called once per frame */
    const updateLoader = () => {
        if (streaming) {
            camera.getWorldDirection(direction)
            const center = { x: blockOf(-camera.position.x), y: blockOf(camera.position.y), z: blockOf(camera.position.z) }
            const rotated = direction.dot(lastDirection) < REPRIORITIZE_DOT
            if (rotated) {
                lastDirection.copy(direction)
            }
            camera.updateMatrixWorld()
            frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
            if (!loader.setCenter(center) && rotated) {
                loader.reprioritize()
            }
        } else {
            loader.setCenter(sceneCenter)
        }

        const sliceStart = performance.now()
        loader.processMeshes(() => performance.now() - sliceStart < MESH_BUDGET)

        const { fetching, meshing } = loader.stats()
        setStatus(fetching > 0 ? `loading mapblocks (${fetching} remaining)`
            : meshing > 0 ? `generating meshes (${meshing} remaining)` : "")
    }

    let started = false
    nodes.ensure(["air"]).then(() => {
        started = true
    }).catch(e => {
        console.error("[luanti-viewer] failed to load the scene", e)
        setStatus(`failed to load the scene: ${e instanceof Error ? e.message : e}`)
    })
}
