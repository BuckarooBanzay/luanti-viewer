import {
    DataTexture, DoubleSide, FrontSide, MeshBasicMaterial, NearestFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace,
    UnsignedByteType, type Material, type Texture
} from "three"
import type { TileRegistry, TileSpec } from "./mesh/nodes.js"
import { cropImage, type RgbaImage, type TextureCompositor } from "./texture/compositor.js"

type Entry = {
    spec: TileSpec
    material: MeshBasicMaterial
    /** one texture per animation frame */
    frames: Texture[]
    /** duration of a single frame in seconds */
    frameLength: number
    currentFrame: number
}

/** splits the texture of an animated tile into its frames */
export function splitFrames(image: RgbaImage, spec: TileSpec): { frames: RgbaImage[], frameLength: number } {
    const animation = spec.animation
    if (animation?.type === "vertical_frames") {
        const aspectW = animation.aspect_w || 16
        const aspectH = animation.aspect_h || 16
        const frameHeight = Math.max(Math.floor(image.width * aspectH / aspectW), 1)
        const count = Math.max(Math.floor(image.height / frameHeight), 1)
        const frames = Array.from({ length: count }, (_, i) => cropImage(image, 0, i * frameHeight, image.width, frameHeight))
        return { frames, frameLength: (animation.length || 1) / count }
    }
    if (animation?.type === "sheet_2d") {
        const columns = Math.max(animation.frames_w || 1, 1)
        const rows = Math.max(animation.frames_h || 1, 1)
        const width = Math.max(Math.floor(image.width / columns), 1)
        const height = Math.max(Math.floor(image.height / rows), 1)
        const frames: RgbaImage[] = []
        for (let i = 0; i < columns * rows; i++) {
            frames.push(cropImage(image, (i % columns) * width, Math.floor(i / columns) * height, width, height))
        }
        return { frames, frameLength: animation.frame_length || 1 }
    }
    return { frames: [image], frameLength: 0 }
}

function createTexture(image: RgbaImage): Texture {
    // three.js expects the first row at the bottom
    const rowLength = image.width * 4
    const data = new Uint8Array(image.data.length)
    for (let y = 0; y < image.height; y++) {
        data.set(image.data.subarray(y * rowLength, (y + 1) * rowLength), (image.height - 1 - y) * rowLength)
    }
    const texture = new DataTexture(data, image.width, image.height, RGBAFormat, UnsignedByteType)
    texture.colorSpace = SRGBColorSpace
    texture.magFilter = NearestFilter
    texture.minFilter = NearestFilter
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.needsUpdate = true
    return texture
}

/** creates one three.js material per tile and animates their textures */
export class MaterialManager implements TileRegistry {
    private readonly entries: Entry[] = []
    private readonly ids = new Map<string, number>()
    private readonly animated: Entry[] = []
    private pending = 0
    /**
     * shared by the shaders of all materials: 1 = full daylight, 0 = only the night light (artificial light)
     * is left, the vertices are blended between their day color and their `nightFactor` attribute
     */
    readonly dayNightRatio = { value: 1 }
    /** called whenever a texture finished loading */
    onTextureLoaded: (() => void) | null = null

    constructor(private readonly textures: TextureCompositor) {}

    getTile(spec: TileSpec): number {
        const key = JSON.stringify([spec.texture, spec.animation ?? null, spec.backfaceCulling, spec.alpha])
        let id = this.ids.get(key)
        if (id === undefined) {
            id = this.entries.length
            this.ids.set(key, id)
            this.entries.push(this.createEntry(spec))
        }
        return id
    }

    getMaterial(id: number): Material {
        return this.entries[id]!.material
    }

    /** resolves once all textures requested so far are loaded */
    get pendingTextures(): number {
        return this.pending
    }

    private createEntry(spec: TileSpec): Entry {
        const material = new MeshBasicMaterial({
            vertexColors: true,
            side: spec.backfaceCulling ? FrontSide : DoubleSide,
            // hidden until the texture is available
            visible: false
        })
        material.onBeforeCompile = shader => {
            shader.uniforms.dayNightRatio = this.dayNightRatio
            // the light is blended in gamma space like the brightness of the mesher, the vertex colors are linear
            shader.vertexShader = "attribute float nightFactor;\nuniform float dayNightRatio;\n"
                + shader.vertexShader.replace("#include <color_vertex>", "#include <color_vertex>\n"
                    + "\tvColor.rgb *= pow(mix(nightFactor, 1.0, dayNightRatio), 2.2);")
        }
        if (spec.alpha === "clip") {
            material.alphaTest = 0.5
        } else if (spec.alpha === "blend") {
            material.transparent = true
            material.depthWrite = false
        }

        const entry: Entry = { spec, material, frames: [], frameLength: 0, currentFrame: 0 }
        this.pending++
        this.textures.generate(spec.texture).then(image => {
            const { frames, frameLength } = splitFrames(image, spec)
            entry.frames = frames.map(createTexture)
            entry.frameLength = frameLength
            material.map = entry.frames[0]!
            material.visible = true
            material.needsUpdate = true
            if (entry.frames.length > 1 && frameLength > 0) {
                this.animated.push(entry)
            }
        }).catch(e => {
            console.error(`[luanti-viewer] failed to create texture '${spec.texture}'`, e)
        }).finally(() => {
            this.pending--
            this.onTextureLoaded?.()
        })
        return entry
    }

    /** switches the animated textures to the frame of the given time (seconds) */
    update(time: number): void {
        for (const entry of this.animated) {
            const frame = Math.floor(time / entry.frameLength) % entry.frames.length
            if (frame !== entry.currentFrame) {
                entry.currentFrame = frame
                entry.material.map = entry.frames[frame]!
            }
        }
    }

    dispose(): void {
        for (const entry of this.entries) {
            entry.frames.forEach(texture => texture.dispose())
            entry.material.dispose()
        }
    }
}
