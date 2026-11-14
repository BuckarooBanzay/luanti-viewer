import {
    BufferAttribute, BufferGeometry, Color, Group, Mesh, PerspectiveCamera, Scene, WebGLRenderer
} from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { MAPBLOCK_SIZE } from "./mapblock"
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
/** time per frame spent on generating meshes (milliseconds) */
const MESH_BUDGET = 12
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

/** runs the tasks with a limited number of them in flight */
async function runParallel<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    const worker = async () => {
        while (next < items.length) {
            await task(items[next++]!)
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

const nextFrame = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/**
 * Renders a luanti scene into the given element.
 * The mapblocks between `minPos` and `maxPos` are loaded and rendered, the camera can be
 * rotated (left mouse button), moved (right mouse button) and zoomed (mouse wheel).
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
    const setStatus = (text: string) => {
        status.textContent = text
        status.style.display = text ? "block" : "none"
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

    // scene bounds in three.js coordinates (x is mirrored)
    const { minPos, maxPos } = options
    const sizeX = (maxPos.x - minPos.x + 1) * MAPBLOCK_SIZE
    const sizeY = (maxPos.y - minPos.y + 1) * MAPBLOCK_SIZE
    const sizeZ = (maxPos.z - minPos.z + 1) * MAPBLOCK_SIZE
    const centerX = -(minPos.x * MAPBLOCK_SIZE + sizeX / 2 - 0.5)
    const centerY = minPos.y * MAPBLOCK_SIZE + sizeY / 2 - 0.5
    const centerZ = minPos.z * MAPBLOCK_SIZE + sizeZ / 2 - 0.5
    const extent = Math.max(sizeX, sizeY, sizeZ)

    const camera = new PerspectiveCamera(60, 1, 0.1, Math.max(extent * 8, 1000))
    camera.position.set(centerX + extent * 0.55, centerY + extent * 0.45, centerZ - extent * 0.55)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(centerX, centerY, centerZ)
    if (options.camera) {
        const { position, target } = options.camera
        camera.position.set(-position.x, position.y, position.z)
        controls.target.set(-target.x, target.y, target.z)
    }
    controls.enableDamping = true
    controls.zoomToCursor = true
    controls.maxDistance = extent * 4
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
        scene.traverse(object => {
            if (object instanceof Mesh) {
                object.geometry.dispose()
            }
        })
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

    const load = async () => {
        const nodes = new NodeRegistry(async name => {
            try {
                return await options.getNodeDefinitions(name)
            } catch (e) {
                console.error(`[luanti-viewer] failed to load node definition '${name}'`, e)
                return null
            }
        }, materials)
        const world = new World(nodes)
        await nodes.ensure(["air"])

        // mapblocks, from the center outwards
        const positions: MapblockPosition[] = []
        for (let x = minPos.x; x <= maxPos.x; x++) {
            for (let y = minPos.y; y <= maxPos.y; y++) {
                for (let z = minPos.z; z <= maxPos.z; z++) {
                    positions.push({ x, y, z })
                }
            }
        }
        const midX = (minPos.x + maxPos.x) / 2, midZ = (minPos.z + maxPos.z) / 2
        const distance = (p: MapblockPosition) => Math.hypot(p.x - midX, p.z - midZ)
        positions.sort((a, b) => distance(a) - distance(b) || b.y - a.y)

        let loaded = 0
        await runParallel(positions, CONCURRENCY, async pos => {
            if (disposed) {
                return
            }
            try {
                const mapblock = await options.getMapblock(pos)
                if (mapblock) {
                    // the node ids are resolved synchronously, the definitions have to be present
                    await nodes.ensure(mapblock.nodeNames.values())
                    world.set(pos, mapblock)
                }
            } catch (e) {
                console.error(`[luanti-viewer] failed to load mapblock (${pos.x},${pos.y},${pos.z})`, e)
            }
            loaded++
            setStatus(`loading mapblocks ${loaded} / ${positions.length}`)
        })

        // models of the mesh nodes that are used in the scene
        setStatus("loading models")
        await Promise.all(nodes.infos.map(async info => {
            if (info.drawtype === "mesh" && info.def.mesh) {
                info.model = await loadModel(info.def.mesh)
            }
        }))

        const mesher = new MapblockMesher(nodes)
        const neighborhood = createNeighborhood()
        const loadedPositions = positions.filter(pos => world.has(pos))
        let meshed = 0
        let sliceStart = performance.now()
        for (const pos of loadedPositions) {
            if (disposed) {
                return
            }
            world.fillNeighborhood(pos, neighborhood)
            const origin = { x: pos.x * MAPBLOCK_SIZE, y: pos.y * MAPBLOCK_SIZE, z: pos.z * MAPBLOCK_SIZE }
            const buffers = mesher.mesh(neighborhood, origin)
            if (buffers.size > 0) {
                const group = new Group()
                group.position.set(-origin.x, origin.y, origin.z)
                for (const [tile, buffer] of buffers) {
                    group.add(new Mesh(createGeometry(buffer), materials.getMaterial(tile)))
                }
                scene.add(group)
            }
            meshed++
            if (performance.now() - sliceStart > MESH_BUDGET) {
                setStatus(`generating meshes ${meshed} / ${loadedPositions.length}`)
                await nextFrame()
                sliceStart = performance.now()
            }
        }
        setStatus("")
    }

    load().catch(e => {
        console.error("[luanti-viewer] failed to load the scene", e)
        setStatus(`failed to load the scene: ${e instanceof Error ? e.message : e}`)
    })
}
