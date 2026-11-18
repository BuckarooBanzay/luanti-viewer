import { Box3, Color, Group, Mesh, PerspectiveCamera, Scene, Sphere, Vector3, WebGLRenderer } from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { createNeighborhood, MapblockMesher, paddedIndex, type MeshBuffer } from "./mesh/mesher.js"
import { NodeRegistry } from "./mesh/nodes.js"
import { SKY_COLOR, createGeometry, createMediaLoader, skyColorAt, startRenderLoop, timeToDayNightRatio } from "./scene.js"
import type { NodeDefinition } from "./types.js"

export type NodeViewerOptions = {
    nodedefinition: NodeDefinition
    /**
     * param2 of the node: rotation (facedir, 4dir, wallmounted, degrotate), palette index of the color types,
     * level of leveled nodes and flowing liquids... depending on the `paramtype2` of the definition.
     * Defaults to 0, except for wallmounted nodes: 1 (standing on the floor, 0 would hang them from the ceiling)
     */
    param2?: number|null
    /** fetches a texture (.png) or model (.obj / .b3d) by its file name, null if it does not exist */
    getMedia(filename: string): Promise<Blob|null>
    /** initial time of day, see `NodeViewer.setTimeOfDay`, defaults to 0.5 (noon) */
    timeOfDay?: number|null
    /**
     * background color (any css color or a number like 0x202020), null for a transparent background
     * that shows the page behind the view, defaults to the sky color of the time of day
     */
    background?: string|number|null
    /** slowly turn the camera around the node, stops while the user drags, defaults to false */
    autoRotate?: boolean|null
}

export type NodeViewer = {
    /**
     * set time of day, range from 0 to 1 (0 = midnight, 0.5 = noon, as in the engine),
     * sets the lighting of the scene accordingly (the node is in full daylight, only the light of
     * nodes with a `light_source` stays at night)
     */
    setTimeOfDay(tod: number): void
    /**
     * Replaces the displayed node, e.g. to browse through a list of nodes without creating a view
     * (and WebGL context) for each one. Textures and models already loaded with `getMedia` are reused,
     * the camera keeps its direction and is moved to fit the new node.
     * `param2` defaults like the `param2` option.
     */
    setNodeDefinition(nodedefinition: NodeDefinition, param2?: number|null): void
    /** turns the auto rotation on or off, same as the `autoRotate` option */
    setAutoRotate(enabled: boolean): void
}

/** vertical field of view of the camera (degrees) */
const FOV = 35
/** initial direction from the node to the camera (three.js coordinates): the front (-z), the right side and the top */
const VIEW_DIRECTION = new Vector3(0.75, 0.7, -1).normalize()
/** free space around the node when the camera is fitted to it */
const FIT_MARGIN = 1.15
/** zoom limits, multiples of the fitted distance */
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
/** degrees per second of the auto rotation */
const AUTO_ROTATE_SPEED = 30
/** param1 of the node and the air around it: full daylight, no artificial light */
const FULL_DAYLIGHT = 0x0f
/** bounding sphere of a full node (three.js coordinates), used for nodes without any faces */
const NODE_SPHERE = new Sphere(new Vector3(), Math.sqrt(3) / 2)

/**
 * Meshes a single node surrounded by air (in full daylight) with the regular mapblock mesher.
 * The node is placed at the origin of the mapblock: its center is at (0, 0, 0).
 * The definition of the node has to be fetched with `NodeRegistry.ensure` beforehand.
 */
export function meshNode(nodes: NodeRegistry, name: string, param2 = 0): Map<number, MeshBuffer> {
    const neighborhood = createNeighborhood()
    // air instead of CONTENT_IGNORE: faces next to ignore are culled or connected differently
    neighborhood.ids.fill(nodes.airId)
    neighborhood.param1.fill(FULL_DAYLIGHT)
    const index = paddedIndex(0, 0, 0)
    neighborhood.ids[index] = nodes.getId(name)
    neighborhood.param2[index] = param2 & 0xff
    return new MapblockMesher(nodes).mesh(neighborhood, { x: 0, y: 0, z: 0 })
}

/** param2 used if none is given: wallmounted nodes stand on the floor */
export function defaultParam2(def: NodeDefinition): number {
    return def.paramtype2 === "wallmounted" || def.paramtype2 === "colorwallmounted" ? 1 : 0
}

/** distance of a camera at which a sphere with the given radius fits into its view */
export function fitDistance(radius: number, fovDegrees: number, aspect: number): number {
    const vertical = fovDegrees * Math.PI / 360
    const horizontal = Math.atan(Math.tan(vertical) * aspect)
    return radius * FIT_MARGIN / Math.sin(Math.min(vertical, horizontal))
}

/**
 * Renders a single node into the given element, in contrast to `createView` there is no map:
 * the node is shown in the center, surrounded by air in full daylight.
 * Drag to orbit around the node, scroll (or pinch on touch devices) to zoom.
 * The view captures the wheel and touch gestures, the page does not scroll over it.
 * All resources are released once the element is removed from the document.
 */
export function createNodeView(element: HTMLElement, options: NodeViewerOptions): NodeViewer {
    const container = document.createElement("div")
    container.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden"
    element.appendChild(container)

    const transparent = options.background === null
    const renderer = new WebGLRenderer({ antialias: true, alpha: transparent })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.domElement.style.display = "block"
    container.appendChild(renderer.domElement)

    const scene = new Scene()
    // the sky follows the time of day, a fixed background color does not
    const skyColor = options.background == null ? new Color(SKY_COLOR) : null
    scene.background = transparent ? null : skyColor ?? new Color(options.background!)

    const camera = new PerspectiveCamera(FOV, 1, 0.01, 100)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false
    controls.enableDamping = true
    controls.autoRotate = options.autoRotate ?? false
    // OrbitControls with a delta time: autoRotateSpeed 1 = 6 degrees per second
    controls.autoRotateSpeed = AUTO_ROTATE_SPEED / 6
    camera.position.copy(VIEW_DIRECTION).multiplyScalar(fitDistance(NODE_SPHERE.radius, FOV, 1))
    camera.lookAt(0, 0, 0)

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

    // nothing is rendered while the view is scrolled out of sight (e.g. in a long list of nodes)
    let visible = true
    const intersectionObserver = new IntersectionObserver(entries => {
        visible = entries[entries.length - 1]!.isIntersecting
    })
    intersectionObserver.observe(container)

    const media = createMediaLoader(options.getMedia)
    const { materials } = media

    const setTimeOfDay = (tod: number) => {
        const ratio = timeToDayNightRatio(tod)
        materials.dayNightRatio.value = ratio
        if (skyColor) {
            skyColorAt(ratio, skyColor)
        }
    }
    setTimeOfDay(options.timeOfDay ?? 0.5)

    let group: Group | null = null
    const removeGroup = () => {
        if (group) {
            scene.remove(group)
            for (const child of group.children) {
                (child as Mesh).geometry.dispose()
            }
            group = null
        }
    }

    /** moves the camera (keeping its direction) and the orbit center to the bounding sphere of the node */
    const box = new Box3(), sphere = new Sphere(), direction = new Vector3()
    const fitCamera = (object: Group) => {
        box.setFromObject(object)
        if (box.isEmpty()) {
            sphere.copy(NODE_SPHERE)
        } else {
            box.getBoundingSphere(sphere)
        }
        const distance = fitDistance(sphere.radius, FOV, camera.aspect)
        direction.subVectors(camera.position, controls.target).normalize()
        controls.target.copy(sphere.center)
        camera.position.copy(sphere.center).addScaledVector(direction, distance)
        controls.minDistance = distance * MIN_ZOOM
        controls.maxDistance = distance * MAX_ZOOM
        camera.near = distance / 100
        camera.far = distance * MAX_ZOOM * 4
        camera.updateProjectionMatrix()
        controls.update()
    }

    /** number of the latest `setNodeDefinition` call, older ones that finish later are dropped */
    let generation = 0
    const setNodeDefinition = (def: NodeDefinition, param2?: number | null) => {
        const id = ++generation
        // a new registry per node: the mesher looks up the nodes by name, the materials are shared
        const nodes = new NodeRegistry(async name => name === def.name ? def : null, materials)
        ;(async () => {
            await nodes.ensure(["air", def.name])
            await media.prepareModels(nodes, [def.name])
            if (id !== generation || disposed) {
                return
            }
            const next = new Group()
            for (const [tile, buffer] of meshNode(nodes, def.name, param2 ?? defaultParam2(def))) {
                next.add(new Mesh(createGeometry(buffer), materials.getMaterial(tile)))
            }
            removeGroup()
            group = next
            scene.add(group)
            fitCamera(group)
        })().catch(e => {
            console.error(`[luanti-viewer] failed to display node '${def.name}'`, e)
        })
    }

    let disposed = false
    const dispose = () => {
        disposed = true
        resizeObserver.disconnect()
        intersectionObserver.disconnect()
        controls.dispose()
        removeGroup()
        materials.dispose()
        renderer.dispose()
        container.remove()
    }

    let lastFrame = performance.now()
    startRenderLoop(renderer, container, now => {
        const dt = Math.min((now - lastFrame) / 1000, 0.1)
        lastFrame = now
        if (!visible) {
            return
        }
        controls.update(dt)
        materials.update(now / 1000)
        renderer.render(scene, camera)
    }, dispose)

    setNodeDefinition(options.nodedefinition, options.param2)

    const setAutoRotate = (enabled: boolean) => {
        controls.autoRotate = enabled
    }

    return { setTimeOfDay, setNodeDefinition, setAutoRotate }
}
