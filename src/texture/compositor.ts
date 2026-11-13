import { parseColorString, parseTexture, parseTransform, splitEscaped, unescape, type TexturePart } from "./parser"

/** uncompressed image with straight (not premultiplied) alpha, rows from top to bottom */
export type RgbaImage = {
    width: number
    height: number
    data: Uint8ClampedArray
}

/** decodes an image file, resolves to null if it does not exist */
export type ImageLoader = (name: string) => Promise<RgbaImage | null>

/** largest image a modifier may create */
const MAX_SIZE = 4096

export function createImage(width: number, height: number): RgbaImage {
    const w = Math.min(Math.max(Math.floor(width), 1), MAX_SIZE)
    const h = Math.min(Math.max(Math.floor(height), 1), MAX_SIZE)
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
}

function cloneImage(image: RgbaImage): RgbaImage {
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }
}

/** placeholder for missing textures */
export function createPlaceholder(): RgbaImage {
    const image = createImage(16, 16)
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            const magenta = ((x >> 3) + (y >> 3)) % 2 === 0
            image.data.set(magenta ? [255, 0, 255, 255] : [0, 0, 0, 255], (y * 16 + x) * 4)
        }
    }
    return image
}

/** nearest neighbor scaling */
export function resizeImage(image: RgbaImage, width: number, height: number): RgbaImage {
    if (image.width === width && image.height === height) {
        return image
    }
    const result = createImage(width, height)
    const src = new Uint32Array(image.data.buffer, image.data.byteOffset, image.width * image.height)
    const dst = new Uint32Array(result.data.buffer)
    for (let y = 0; y < result.height; y++) {
        const sy = Math.min(Math.floor(y * image.height / result.height), image.height - 1)
        for (let x = 0; x < result.width; x++) {
            const sx = Math.min(Math.floor(x * image.width / result.width), image.width - 1)
            dst[y * result.width + x] = src[sy * image.width + sx]!
        }
    }
    return result
}

/** copies a part of an image */
export function cropImage(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
    const result = createImage(width, height)
    for (let row = 0; row < result.height; row++) {
        const sy = y + row
        if (sy < 0 || sy >= image.height) {
            continue
        }
        const x1 = Math.max(x, 0)
        const x2 = Math.min(x + result.width, image.width)
        if (x2 > x1) {
            result.data.set(image.data.subarray((sy * image.width + x1) * 4, (sy * image.width + x2) * 4), (row * result.width + x1 - x) * 4)
        }
    }
    return result
}

/** alpha-blends `src` over `dst` at the given position, optionally only a region of the source */
export function blit(
    dst: RgbaImage, src: RgbaImage, dstX = 0, dstY = 0,
    srcX = 0, srcY = 0, width = src.width, height = src.height
): void {
    for (let y = 0; y < height; y++) {
        const sy = srcY + y, dy = dstY + y
        if (sy < 0 || sy >= src.height || dy < 0 || dy >= dst.height) {
            continue
        }
        for (let x = 0; x < width; x++) {
            const sx = srcX + x, dx = dstX + x
            if (sx < 0 || sx >= src.width || dx < 0 || dx >= dst.width) {
                continue
            }
            const s = (sy * src.width + sx) * 4
            const d = (dy * dst.width + dx) * 4
            const sa = src.data[s + 3]! / 255
            if (sa === 0) {
                continue
            }
            const da = dst.data[d + 3]! / 255
            const outA = sa + da * (1 - sa)
            for (let c = 0; c < 3; c++) {
                dst.data[d + c] = (src.data[s + c]! * sa + dst.data[d + c]! * da * (1 - sa)) / outA
            }
            dst.data[d + 3] = outA * 255
        }
    }
}

/** see imageTransform in the engine */
export function transformImage(image: RgbaImage, transform: number): RgbaImage {
    if (transform === 0) {
        return image
    }
    const swap = transform % 2 === 1
    const result = createImage(swap ? image.height : image.width, swap ? image.width : image.height)
    // source coordinate selectors: 0 = dx, 1 = width - 1 - dx, 2 = dy, 3 = height - 1 - dy
    const [sxn, syn] = ([[0, 2], [3, 0], [1, 3], [2, 1], [1, 2], [2, 0], [0, 3], [3, 1]] as const)[transform & 7]!
    const src = new Uint32Array(image.data.buffer, image.data.byteOffset, image.width * image.height)
    const dst = new Uint32Array(result.data.buffer)
    for (let dy = 0; dy < result.height; dy++) {
        for (let dx = 0; dx < result.width; dx++) {
            const entries = [dx, result.width - 1 - dx, dy, result.height - 1 - dy]
            dst[dy * result.width + dx] = src[entries[syn]! * image.width + entries[sxn]!]!
        }
    }
    return result
}

function forEachPixel(image: RgbaImage, fn: (data: Uint8ClampedArray, offset: number) => void): void {
    for (let o = 0; o < image.data.length; o += 4) {
        fn(image.data, o)
    }
}

/** scales both images to the size of the larger one */
function matchLargest(a: RgbaImage, b: RgbaImage): [RgbaImage, RgbaImage] {
    if (a.width === b.width && a.height === b.height) {
        return [a, b]
    }
    if (a.width * a.height < b.width * b.height) {
        return [resizeImage(a, b.width, b.height), b]
    }
    return [a, resizeImage(b, a.width, a.height)]
}

const parseSize = (text: string | undefined): [number, number] | null => {
    const match = /^(\d+)x(\d+)$/.exec(text ?? "")
    return match ? [parseInt(match[1]!, 10), parseInt(match[2]!, 10)] : null
}

/** evaluates luanti texture strings including their modifiers */
export class TextureCompositor {
    private readonly files = new Map<string, Promise<RgbaImage>>()
    private readonly warned = new Set<string>()

    constructor(private readonly loader: ImageLoader) {}

    /** generates the image of a texture string, missing files are replaced by a placeholder */
    async generate(texture: string): Promise<RgbaImage> {
        const image = await this.evaluate(parseTexture(texture))
        return image ?? createPlaceholder()
    }

    private warn(message: string): void {
        if (!this.warned.has(message)) {
            this.warned.add(message)
            console.warn(`[luanti-viewer] ${message}`)
        }
    }

    private loadFile(name: string): Promise<RgbaImage> {
        let image = this.files.get(name)
        if (!image) {
            image = this.loader(name).catch(() => null).then(result => {
                if (result) {
                    return result
                }
                // textures that are built into the engine and not part of the media
                if (name === "blank.png") {
                    return createImage(1, 1)
                }
                if (name !== "no_texture.png" && name !== "unknown_node.png") {
                    this.warn(`texture not found: ${name}`)
                }
                return createPlaceholder()
            })
            this.files.set(name, image)
        }
        return image
    }

    private async evaluate(parts: TexturePart[]): Promise<RgbaImage | null> {
        let base: RgbaImage | null = null
        for (const part of parts) {
            if (part.type === "modifier") {
                base = await this.applyModifier(base, part.name, part.args)
                continue
            }
            const image = part.type === "file" ? await this.loadFile(part.name) : await this.evaluate(part.parts)
            if (!image) {
                continue
            }
            if (!base) {
                // loaded files are shared, never modify them
                base = cloneImage(image)
            } else {
                const [dst, src] = matchLargest(base, image)
                base = dst
                blit(base, src)
            }
        }
        return base
    }

    private async applyModifier(base: RgbaImage | null, name: string, args: string): Promise<RgbaImage | null> {
        const fields = splitEscaped(args, ":")

        // modifiers that can create an image
        switch (name) {
            case "combine": {
                const size = parseSize(fields[0])
                if (!size) {
                    return base
                }
                const result = base ?? createImage(size[0], size[1])
                for (const entry of fields.slice(1)) {
                    const match = /^(-?\d+),(-?\d+)=([\s\S]*)$/.exec(entry)
                    if (!match) {
                        continue
                    }
                    const image = await this.generate(unescape(match[3]!))
                    blit(result, image, parseInt(match[1]!, 10), parseInt(match[2]!, 10))
                }
                return result
            }
            case "fill": {
                const size = parseSize(fields[0])
                const color = parseColorString(fields[fields.length - 1] ?? "")
                if (!size || !color) {
                    return base
                }
                const fill = createImage(size[0], size[1])
                forEachPixel(fill, (data, o) => data.set(color, o))
                if (!base) {
                    return fill
                }
                const position = fields.length >= 3 ? /^(-?\d+),(-?\d+)$/.exec(fields[1]!) : null
                blit(base, fill, position ? parseInt(position[1]!, 10) : 0, position ? parseInt(position[2]!, 10) : 0)
                return base
            }
            case "lowpart": {
                const percent = Math.min(Math.max(parseInt(fields[0] ?? "", 10) || 0, 0), 100)
                const image = await this.generate(unescape(fields.slice(1).join(":")))
                const result = base ?? createImage(image.width, image.height)
                const y = Math.floor(image.height * (100 - percent) / 100)
                blit(result, image, 0, y, 0, y, image.width, Math.floor(image.height * percent / 100) + 1)
                return result
            }
            case "crack":
            case "cracko":
            case "applyfiltersformesh":
                // not relevant for a static scene
                return base
        }

        if (!base) {
            this.warn(`texture modifier [${name} needs a base image`)
            return null
        }

        switch (name) {
            case "transform":
                return transformImage(base, parseTransform(args))
            case "colorize": {
                const color = parseColorString(fields[0] ?? "")
                if (!color) {
                    return base
                }
                const keepAlpha = fields[1] === "alpha"
                const ratio = /^\d+$/.test(fields[1] ?? "") ? Math.min(parseInt(fields[1]!, 10), 255) : -1
                if ((ratio === -1 && color[3] === 255) || ratio === 255) {
                    forEachPixel(base, (data, o) => {
                        if (data[o + 3]! > 0) {
                            const alpha = keepAlpha ? data[o + 3]! * color[3] / 255 : color[3]
                            data.set(color, o)
                            data[o + 3] = alpha
                        }
                    })
                } else {
                    const t = (ratio === -1 ? color[3] : ratio) / 255
                    forEachPixel(base, (data, o) => {
                        if (data[o + 3]! > 0) {
                            for (let c = 0; c < 4; c++) {
                                data[o + c] = color[c]! * t + data[o + c]! * (1 - t)
                            }
                        }
                    })
                }
                return base
            }
            case "multiply":
            case "screen": {
                const color = parseColorString(fields[0] ?? "")
                if (color) {
                    forEachPixel(base, (data, o) => {
                        for (let c = 0; c < 3; c++) {
                            data[o + c] = name === "multiply"
                                ? data[o + c]! * color[c]! / 255
                                : 255 - (255 - data[o + c]!) * (255 - color[c]!) / 255
                        }
                    })
                }
                return base
            }
            case "brighten":
                forEachPixel(base, (data, o) => {
                    for (let c = 0; c < 3; c++) {
                        data[o + c] = 127.5 + 0.5 * data[o + c]!
                    }
                })
                return base
            case "noalpha":
                forEachPixel(base, (data, o) => { data[o + 3] = 255 })
                return base
            case "makealpha": {
                const [r, g, b] = (fields[0] ?? "").split(",").map(v => parseInt(v, 10))
                forEachPixel(base, (data, o) => {
                    if (data[o] === r && data[o + 1] === g && data[o + 2] === b) {
                        data[o + 3] = 0
                    }
                })
                return base
            }
            case "opacity": {
                const ratio = Math.min(Math.max(parseInt(fields[0] ?? "", 10) || 0, 0), 255)
                forEachPixel(base, (data, o) => { data[o + 3] = data[o + 3]! * ratio / 255 })
                return base
            }
            case "invert": {
                const mode = fields[0] ?? ""
                const channels = [..."rgba"].map(c => mode.includes(c))
                forEachPixel(base, (data, o) => {
                    for (let c = 0; c < 4; c++) {
                        if (channels[c]) {
                            data[o + c] = 255 - data[o + c]!
                        }
                    }
                })
                return base
            }
            case "resize": {
                const size = parseSize(fields[0])
                return size ? resizeImage(base, Math.min(size[0], MAX_SIZE), Math.min(size[1], MAX_SIZE)) : base
            }
            case "verticalframe": {
                const count = Math.max(parseInt(fields[0] ?? "", 10) || 1, 1)
                const index = Math.min(Math.max(parseInt(fields[1] ?? "", 10) || 0, 0), count - 1)
                const height = Math.max(Math.floor(base.height / count), 1)
                return cropImage(base, 0, index * height, base.width, height)
            }
            case "sheet": {
                const size = parseSize(fields[0])
                const position = /^(\d+),(\d+)$/.exec(fields[1] ?? "")
                if (!size || !position || size[0] === 0 || size[1] === 0) {
                    return base
                }
                const width = Math.max(Math.floor(base.width / size[0]), 1)
                const height = Math.max(Math.floor(base.height / size[1]), 1)
                return cropImage(base, parseInt(position[1]!, 10) * width, parseInt(position[2]!, 10) * height, width, height)
            }
            case "mask": {
                const mask = await this.generate(unescape(fields.join(":")))
                const [image, scaledMask] = matchLargest(base, mask)
                for (let o = 0; o < image.data.length; o++) {
                    image.data[o] = image.data[o]! & scaledMask.data[o]!
                }
                return image
            }
            case "overlay":
            case "hardlight": {
                const other = await this.generate(unescape(fields.join(":")))
                const [image, scaled] = matchLargest(base, other)
                forEachPixel(image, (data, o) => {
                    for (let c = 0; c < 3; c++) {
                        // overlay decides by the base, hardlight by the blended image
                        const a = data[o + c]! / 255, b = scaled.data[o + c]! / 255
                        const decider = name === "overlay" ? a : b
                        data[o + c] = 255 * (decider < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b))
                    }
                })
                return image
            }
            default:
                this.warn(`unsupported texture modifier: [${name}`)
                return base
        }
    }
}
