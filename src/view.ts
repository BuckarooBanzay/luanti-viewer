import {
    BufferAttribute, BufferGeometry, Box3, Color, Euler, Fog, Frustum, Group, Matrix4, Mesh, PerspectiveCamera,
    Scene, Vector3, WebGLRenderer
} from "three"
import { PLAYER_EYE_HEIGHT, collide, isFree } from "./physics.js"
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js"
import { MapblockLoader, UNLOAD_MARGIN } from "./loader.js"
import { MAPBLOCK_SIZE, type ParsedMapblock } from "./mapblock.js"
import { MaterialManager } from "./materials.js"
import { createNeighborhood, MapblockMesher, type MeshBuffer } from "./mesh/mesher.js"
import { NodeRegistry } from "./mesh/nodes.js"
import { parseB3d } from "./models/b3d.js"
import type { Model } from "./models/model.js"
import { parseObj } from "./models/obj.js"
import { TextureCompositor, type RgbaImage } from "./texture/compositor.js"
import { applyLook, createTouchControls } from "./touch.js"
import type { MapblockPosition, Viewer, ViewerCamera, ViewerOptions } from "./types.js"
import { World } from "./world.js"

const SKY_COLOR = 0x8cbafa
/** sky color without any daylight */
const NIGHT_SKY_COLOR = 0x03060f
/** day night ratio (0..1) by the time of day (0..0.5, mirrored at noon), see time_to_daynight_ratio in the engine */
const DAYNIGHT_RATIOS: readonly (readonly [number, number])[] = [
    [4375, 175], [4625, 175], [4875, 250], [5125, 350], [5375, 500], [5625, 675], [5875, 875], [6125, 1000]
].map(([time, ratio]) => [time! / 24000, ratio! / 1000] as const)
const NIGHT_RATIO = DAYNIGHT_RATIOS[0]![1]

/**
 * share of the daylight (0.175 at night .. 1 at day) for a time of day (0 = midnight, 0.5 = noon),
 * times out of range wrap around
 */
export function timeToDayNightRatio(tod: number): number {
    let t = Number.isFinite(tod) ? tod - Math.floor(tod) : 0.5
    if (t > 0.5) {
        t = 1 - t
    }
    let [lastTime, lastRatio] = DAYNIGHT_RATIOS[0]!
    for (const [time, ratio] of DAYNIGHT_RATIOS) {
        if (t <= time) {
            return time === lastTime ? ratio : lastRatio + (ratio - lastRatio) * (t - lastTime) / (time - lastTime)
        }
        lastTime = time
        lastRatio = ratio
    }
    return 1
}
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
/** camera movement speed in nodes per second, multiplied by FAST_FACTOR while the fast key is held */
const MOVE_SPEED = 50
const FAST_FACTOR = 2
/** walking mode: speed (nodes per second, multiplied by FAST_FACTOR with the fast key), gravity and jump */
const WALK_SPEED = 4.5
const GRAVITY = 20
const JUMP_SPEED = 7
const MAX_FALL_SPEED = 50
/** how far (nodes) a player inside of a node is lifted to find free space */
const MAX_UNSTUCK = 32
/** half edge length (nodes) of the box around the flying camera, keeps the near plane out of the nodes */
const CAMERA_HALF_SIZE = 0.25
/** bounds of the view range (mapblocks), a set `viewRange` is clamped to them */
const MIN_VIEW_RANGE = 4
const MAX_VIEW_RANGE = 20
/** distance of the reported camera target from the camera position (nodes) */
const TARGET_DISTANCE = 1
/** longest frame time used for the movement (seconds), a stalled tab does not teleport the camera */
const MAX_FRAME_TIME = 0.1

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
    // vertices without a night factor keep their brightness
    const nightFactors = new Uint8Array(count).fill(255)
    for (let i = 0; i < buffer.nightFactors.length; i++) {
        nightFactors[i] = Math.round(buffer.nightFactors[i]! * 255)
    }
    geometry.setAttribute("nightFactor", new BufferAttribute(nightFactors, 1, true))
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
 * First person camera: a click into the view captures the mouse (pointer lock) to look around,
 * W/A/S/D moves, Space/Shift moves up/down, E moves faster and Esc or T releases the mouse.
 * C toggles the walking mode (see `ViewerOptions.collision`): gravity and collision with the terrain, Space jumps.
 * H toggles noclip (see `ViewerOptions.noclip`): the flying camera passes through the terrain instead of being stopped by it.
 * On touch devices a tap into the view shows on-screen controls instead (see `ViewerOptions.touchControls`).
 * All resources are released once the element is removed from the document.
 */
export function createView(element: HTMLElement, options: ViewerOptions): Viewer {
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
    const skyColor = new Color(SKY_COLOR)
    scene.background = skyColor

    if (Number.isNaN(options.viewRange)) {
        throw new Error("viewRange has to be a number")
    }
    // without a view range the whole scene is loaded, otherwise it is clamped to a sensible radius
    const viewRange = options.viewRange == null
        ? Infinity
        : Math.min(Math.max(options.viewRange, MIN_VIEW_RANGE), MAX_VIEW_RANGE)
    const streaming = Number.isFinite(viewRange)
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

    // with a view range the border of the loaded area is hidden by fog, the initial camera stays within it
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

    if (options.camera) {
        const { position, target } = options.camera
        camera.position.set(-position.x, position.y, position.z)
        camera.lookAt(-target.x, target.y, target.z)
    } else {
        camera.lookAt(centerX, centerY, centerZ)
    }

    const controls = new PointerLockControls(camera, renderer.domElement)
    const hint = document.createElement("div")
    hint.style.cssText = "position:absolute;left:50%;top:8px;transform:translateX(-50%);padding:4px 8px;"
        + "border-radius:4px;font:12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);"
        + "pointer-events:none;white-space:nowrap"
    const keyboardHint = "Click to look around \u00b7 WASD to move \u00b7 Space/Shift up/down \u00b7 E fast \u00b7 C walk/fly \u00b7 H noclip \u00b7 Esc/T to release"

    // touch devices: on-screen controls instead of the pointer lock, the camera is turned by drags
    const lookEuler = new Euler(0, 0, 0, "YXZ")
    const touch = options.touchControls === false ? null : createTouchControls(container, {
        look: (dx, dy) => {
            lookEuler.setFromQuaternion(camera.quaternion)
            const { yaw, pitch } = applyLook(lookEuler.y, lookEuler.x, dx, dy)
            lookEuler.set(pitch, yaw, 0)
            camera.quaternion.setFromEuler(lookEuler)
        },
        toggleWalking: () => setCollision(!walking),
        toggleNoclip: () => setNoclip(!noclip),
        deactivated: () => hint.style.display = "block"
    })
    hint.textContent = touch && window.matchMedia?.("(pointer: coarse)").matches
        ? "Tap to look around and move"
        : keyboardHint
    container.appendChild(hint)

    // keys are only handled while the mouse is captured, the embedding page keeps its keyboard otherwise
    const pressed = new Set<string>()
    const onKey = (e: KeyboardEvent) => {
        if (!controls.isLocked) {
            return
        }
        if (e.type === "keydown" && e.code === "KeyT") {
            // releases the mouse like Esc (the unlock event clears the pressed keys)
            controls.unlock()
        } else if (e.type === "keydown" && e.code === "KeyC") {
            if (!e.repeat) {
                setCollision(!walking)
            }
        } else if (e.type === "keydown" && e.code === "KeyH") {
            if (!e.repeat) {
                setNoclip(!noclip)
            }
        } else if (e.type === "keydown") {
            pressed.add(e.code)
        } else {
            pressed.delete(e.code)
        }
        e.preventDefault()
    }
    const releaseKeys = () => pressed.clear()
    // a tap shows the touch controls (the page scrolls with touches on the view until then), a click captures the mouse
    let pointerType = "mouse"
    const onPointerDown = (e: PointerEvent) => pointerType = e.pointerType
    const onClick = () => {
        if (touch && pointerType === "touch") {
            touch.activate()
            hint.style.display = "none"
        } else {
            controls.lock()
        }
    }
    renderer.domElement.addEventListener("pointerdown", onPointerDown)
    renderer.domElement.addEventListener("click", onClick)
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKey)
    window.addEventListener("blur", releaseKeys)
    controls.addEventListener("lock", () => hint.style.display = "none")
    controls.addEventListener("unlock", () => {
        releaseKeys()
        hint.style.display = "block"
    })

    const forward = new Vector3()
    // keys and touch controls combined, each axis -1..1 (analog with the joystick)
    const axis = (positive: string, negative: string, analog = 0) =>
        Math.max(-1, Math.min(1, (pressed.has(positive) ? 1 : 0) - (pressed.has(negative) ? 1 : 0) + analog))
    const forwardAxis = () => axis("KeyW", "KeyS", touch?.input.forward)
    const rightAxis = () => axis("KeyD", "KeyA", touch?.input.right)
    const fastFactor = () => pressed.has("KeyE") || touch?.input.fast ? FAST_FACTOR : 1
    // flying without noclip: a small box around the camera is stopped by the loaded walkable nodes
    let noclip = false
    const obstacles = { isSolid: (x: number, y: number, z: number) => world.isObstacle(x, y, z) }
    const flyMove = (dt: number) => {
        const distance = MOVE_SPEED * fastFactor() * dt
        const f = forwardAxis(), r = rightAxis()
        const u = axis("Space", pressed.has("ShiftRight") ? "ShiftRight" : "ShiftLeft", touch?.input.up)
        if (f === 0 && r === 0 && u === 0) {
            return
        }
        // diagonal movement is not faster than straight movement
        forward.set(r, u, f)
        if (forward.lengthSq() > 1) {
            forward.normalize()
        }
        forward.multiplyScalar(distance)
        // engine coordinates (x is mirrored) of the lower center of the camera box before the movement
        const x = -camera.position.x, y = camera.position.y - CAMERA_HALF_SIZE, z = camera.position.z
        controls.moveForward(forward.z)
        controls.moveRight(forward.x)
        camera.position.y += forward.y
        // a camera that is already inside of a node (e.g. the mapblocks were loaded around it) moves freely to get out
        if (!noclip && isFree(obstacles, x, y, z, CAMERA_HALF_SIZE, CAMERA_HALF_SIZE * 2)) {
            const result = collide(
                obstacles, x, y, z, -camera.position.x - x, camera.position.y - CAMERA_HALF_SIZE - y, camera.position.z - z,
                CAMERA_HALF_SIZE, CAMERA_HALF_SIZE * 2)
            camera.position.set(-result.x, result.y + CAMERA_HALF_SIZE, result.z)
        }
    }

    // walking mode: the player box is checked against the loaded nodes (engine coordinates, x is mirrored)
    let walking = false
    let verticalSpeed = 0
    let onGround = false
    const look = new Vector3()
    const walkMove = (dt: number) => {
        let x = -camera.position.x, y = camera.position.y - PLAYER_EYE_HEIGHT, z = camera.position.z
        // inside of a node (e.g. after switching the mode or while the mapblocks load): lift to the next free space
        if (!isFree(world, x, y, z)) {
            for (let i = 1; i <= MAX_UNSTUCK; i++) {
                if (isFree(world, x, y + i, z)) {
                    camera.position.y += i
                    y += i
                    verticalSpeed = 0
                    break
                }
            }
        }

        // horizontal movement relative to the view direction, ignoring the pitch
        camera.getWorldDirection(look)
        look.y = 0
        let dx = 0, dz = 0
        const f = forwardAxis(), r = rightAxis()
        if ((f !== 0 || r !== 0) && look.lengthSq() > 1e-8) {
            look.normalize()
            // diagonal movement is not faster than straight movement
            const speed = WALK_SPEED * fastFactor() / Math.max(Math.hypot(f, r), 1)
            // three.js: right = (-look.z, look.x), x is mirrored for the world
            const tx = (look.x * f - look.z * r) * speed * dt, tz = (look.z * f + look.x * r) * speed * dt
            dx = -tx
            dz = tz
        }
        if (onGround && (pressed.has("Space") || (touch?.input.up ?? 0) > 0)) {
            verticalSpeed = JUMP_SPEED
        }
        verticalSpeed = Math.max(verticalSpeed - GRAVITY * dt, -MAX_FALL_SPEED)

        const result = collide(world, x, y, z, dx, verticalSpeed * dt, dz)
        if (result.hitY) {
            verticalSpeed = 0
        }
        onGround = result.onGround
        camera.position.set(-result.x, result.y + PLAYER_EYE_HEIGHT, result.z)
    }
    const move = (dt: number) => walking ? walkMove(dt) : flyMove(dt)

    const setCollision = (enabled: boolean) => {
        if (enabled !== walking) {
            walking = enabled
            verticalSpeed = 0
            onGround = false
        }
        touch?.setWalking(walking)
    }
    setCollision(options.collision ?? false)

    const setNoclip = (enabled: boolean) => {
        noclip = enabled
        touch?.setNoclip(noclip)
    }
    setNoclip(options.noclip ?? false)

    // the camera is reported (in node coordinates) after every frame in which it moved or turned
    const reportedPosition = new Vector3(NaN, NaN, NaN)
    const reportedDirection = new Vector3(NaN, NaN, NaN)
    const cameraDirection = new Vector3()
    const reportCamera = () => {
        const callback = options.events?.camera
        if (!callback) {
            return
        }
        camera.getWorldDirection(cameraDirection)
        if (camera.position.equals(reportedPosition) && cameraDirection.equals(reportedDirection)) {
            return
        }
        reportedPosition.copy(camera.position)
        reportedDirection.copy(cameraDirection)
        const { x, y, z } = camera.position
        const target = cameraDirection.multiplyScalar(TARGET_DISTANCE).add(camera.position)
        const state: ViewerCamera = {
            position: { x: -x, y, z },
            target: { x: -target.x, y: target.y, z: target.z }
        }
        try {
            callback(state)
        } catch (e) {
            console.error("[luanti-viewer] camera event handler failed", e)
        }
    }

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

    const daySky = new Color(SKY_COLOR), nightSky = new Color(NIGHT_SKY_COLOR)
    const setTimeOfDay = (tod: number) => {
        const ratio = timeToDayNightRatio(tod)
        // the night light (artificial light) is not dimmed, the daylight down to the brightness of the night
        materials.dayNightRatio.value = ratio
        skyColor.lerpColors(nightSky, daySky, ((ratio - NIGHT_RATIO) / (1 - NIGHT_RATIO)) ** 2.2)
        if (scene.fog) {
            scene.fog.color.copy(skyColor)
        }
    }
    setTimeOfDay(options.timeOfDay ?? 0.5)

    let disposed = false
    let wasConnected = false
    const dispose = () => {
        disposed = true
        renderer.setAnimationLoop(null)
        resizeObserver.disconnect()
        renderer.domElement.removeEventListener("pointerdown", onPointerDown)
        renderer.domElement.removeEventListener("click", onClick)
        window.removeEventListener("keydown", onKey)
        window.removeEventListener("keyup", onKey)
        window.removeEventListener("blur", releaseKeys)
        controls.unlock()
        controls.dispose()
        loader.dispose()
        materials.dispose()
        renderer.dispose()
        container.remove()
    }

    const start = performance.now()
    let fpsFrames = 0
    let fpsStart = start
    let lastFrame = start
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
        move(Math.min((now - lastFrame) / 1000, MAX_FRAME_TIME))
        lastFrame = now
        reportCamera()
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

    return { setTimeOfDay, setCollision, setNoclip }
}
