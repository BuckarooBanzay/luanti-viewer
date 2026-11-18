/**
 * Building blocks shared by `createView` and `createNodeView`: conversion of the mesher output to three.js,
 * the day/night lighting, loading of textures and models and the render loop.
 */
import { BufferAttribute, BufferGeometry, Color, type WebGLRenderer } from "three"
import { MaterialManager } from "./materials.js"
import type { MeshBuffer } from "./mesh/mesher.js"
import type { NodeRegistry } from "./mesh/nodes.js"
import { parseB3d } from "./models/b3d.js"
import type { Model } from "./models/model.js"
import { parseObj } from "./models/obj.js"
import { TextureCompositor, type RgbaImage } from "./texture/compositor.js"

export const SKY_COLOR = 0x8cbafa
/** sky color without any daylight */
export const NIGHT_SKY_COLOR = 0x03060f
/** day night ratio (0..1) by the time of day (0..0.5, mirrored at noon), see time_to_daynight_ratio in the engine */
const DAYNIGHT_RATIOS: readonly (readonly [number, number])[] = [
    [4375, 175], [4625, 175], [4875, 250], [5125, 350], [5375, 500], [5625, 675], [5875, 875], [6125, 1000]
].map(([time, ratio]) => [time! / 24000, ratio! / 1000] as const)
export const NIGHT_RATIO = DAYNIGHT_RATIOS[0]![1]

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
export async function decodeImage(blob: Blob): Promise<RgbaImage> {
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

const DAY_SKY = new Color(SKY_COLOR), NIGHT_SKY = new Color(NIGHT_SKY_COLOR)

/**
 * sky color for a day night ratio (see `timeToDayNightRatio`), written into `target`:
 * the daylight fades to the night sky like the brightness of the nodes
 */
export function skyColorAt(ratio: number, target: Color): Color {
    return target.lerpColors(NIGHT_SKY, DAY_SKY, ((ratio - NIGHT_RATIO) / (1 - NIGHT_RATIO)) ** 2.2)
}

/** textures, materials and models of a view, everything is fetched with `getMedia` once */
export type MediaLoader = {
    materials: MaterialManager
    /** parses an .obj or .b3d model, null if it is missing or broken (a warning is logged) */
    loadModel(name: string): Promise<Model | null>
    /**
     * loads the models of the given nodes with drawtype "mesh", the mesher resolves them synchronously,
     * the node definitions have to be fetched with `NodeRegistry.ensure` beforehand
     */
    prepareModels(nodes: NodeRegistry, names: Iterable<string>): Promise<void>
}

export function createMediaLoader(getMedia: (filename: string) => Promise<Blob | null>): MediaLoader {
    const textures = new TextureCompositor(async name => {
        const blob = await getMedia(name)
        return blob ? decodeImage(blob) : null
    })
    const materials = new MaterialManager(textures)

    const models = new Map<string, Promise<Model | null>>()
    const loadModel = (name: string): Promise<Model | null> => {
        let model = models.get(name)
        if (!model) {
            model = (async () => {
                const blob = await getMedia(name)
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

    const prepareModels = async (nodes: NodeRegistry, names: Iterable<string>) => {
        await Promise.all(Array.from(names, async name => {
            const info = nodes.infos[nodes.getId(name)]!
            if (info.drawtype === "mesh" && info.def.mesh && !info.model) {
                info.model = await loadModel(info.def.mesh)
            }
        }))
    }

    return { materials, loadModel, prepareModels }
}

/**
 * Runs `frame` once per animation frame of the renderer. `dispose` is called once the container was
 * attached to the document and is removed again, the view releases its resources then.
 */
export function startRenderLoop(
    renderer: WebGLRenderer, container: HTMLElement, frame: (now: number) => void, dispose: () => void
): void {
    let wasConnected = false
    renderer.setAnimationLoop(() => {
        if (container.isConnected) {
            wasConnected = true
        } else if (wasConnected) {
            renderer.setAnimationLoop(null)
            dispose()
            return
        }
        frame(performance.now())
    })
}
