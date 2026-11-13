import { describe, expect, it, vi } from "vitest"
import { createImage, TextureCompositor, transformImage, type RgbaImage } from "./compositor"

/** builds an image from rows of single characters, see the palette */
function image(...rows: string[]): RgbaImage {
    const palette: Record<string, number[]> = {
        r: [255, 0, 0, 255], g: [0, 255, 0, 255], b: [0, 0, 255, 255], w: [255, 255, 255, 255],
        k: [0, 0, 0, 255], ".": [0, 0, 0, 0], h: [255, 255, 255, 128]
    }
    const result = createImage(rows[0]!.length, rows.length)
    rows.forEach((row, y) => [...row].forEach((c, x) => result.data.set(palette[c]!, (y * result.width + x) * 4)))
    return result
}

const pixel = (img: RgbaImage, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)]

const files: Record<string, RgbaImage> = {
    "red.png": image("rr", "rr"),
    "corner.png": image("g.", ".."),
    "quad.png": image("rg", "bw"),
    "strip.png": image("r", "g", "b", "w"),
    "big.png": image("bbbb", "bbbb", "bbbb", "bbbb"),
    "half.png": image("hh", "hh")
}
const compositor = () => new TextureCompositor(async name => files[name] ?? null)

describe("TextureCompositor", () => {
    it("loads files without modifying the cached image", async () => {
        const c = compositor()
        const result = await c.generate("red.png^[colorize:#00f")
        expect(pixel(result, 0, 0)).toEqual([0, 0, 255, 255])
        expect(pixel(await c.generate("red.png"), 0, 0)).toEqual([255, 0, 0, 255])
    })

    it("overlays images with alpha", async () => {
        const result = await compositor().generate("red.png^corner.png")
        expect(pixel(result, 0, 0)).toEqual([0, 255, 0, 255])
        expect(pixel(result, 1, 1)).toEqual([255, 0, 0, 255])

        const blended = await compositor().generate("red.png^half.png")
        expect(pixel(blended, 0, 0)).toEqual([255, 128, 128, 255])
    })

    it("scales the smaller image when the sizes differ", async () => {
        const result = await compositor().generate("big.png^corner.png")
        expect(result.width).toBe(4)
        expect(pixel(result, 1, 1)).toEqual([0, 255, 0, 255])
        expect(pixel(result, 2, 2)).toEqual([0, 0, 255, 255])
    })

    it("applies the 8 transformations like the engine", () => {
        const quad = files["quad.png"]!
        const layout = (t: number) => {
            const img = transformImage(quad, t)
            const name = (x: number, y: number) => ({ "255,0,0": "r", "0,255,0": "g", "0,0,255": "b", "255,255,255": "w" })[pixel(img, x, y).slice(0, 3).join(",")]
            return name(0, 0)! + name(1, 0)! + name(0, 1)! + name(1, 1)!
        }
        expect(layout(0)).toBe("rgbw")
        expect(layout(1)).toBe("gwrb") // rotated by 90 degrees counterclockwise
        expect(layout(2)).toBe("wbgr")
        expect(layout(3)).toBe("brwg")
        expect(layout(4)).toBe("grwb") // flipped horizontally
        expect(layout(6)).toBe("bwrg") // flipped vertically
    })

    it("supports grouping", async () => {
        const result = await compositor().generate("red.png^(corner.png^[transformFX)")
        expect(pixel(result, 1, 0)).toEqual([0, 255, 0, 255])
        expect(pixel(result, 0, 0)).toEqual([255, 0, 0, 255])
    })

    it("supports colorize, multiply, opacity, noalpha, invert, brighten and makealpha", async () => {
        const c = compositor()
        expect(pixel(await c.generate("red.png^[colorize:#0000ff:128"), 0, 0)).toEqual([127, 0, 128, 255])
        // transparent pixels are not colorized
        expect(pixel(await c.generate("corner.png^[colorize:#00f"), 1, 1)).toEqual([0, 0, 0, 0])
        expect(pixel(await c.generate("quad.png^[multiply:#804020"), 1, 1)).toEqual([128, 64, 32, 255])
        expect(pixel(await c.generate("red.png^[opacity:51"), 0, 0)).toEqual([255, 0, 0, 51])
        expect(pixel(await c.generate("corner.png^[noalpha"), 1, 1)).toEqual([0, 0, 0, 255])
        expect(pixel(await c.generate("red.png^[invert:rg"), 0, 0)).toEqual([0, 255, 0, 255])
        expect(pixel(await c.generate("red.png^[brighten"), 0, 0)).toEqual([255, 128, 128, 255])
        expect(pixel(await c.generate("quad.png^[makealpha:0,255,0"), 1, 0)).toEqual([0, 255, 0, 0])
    })

    it("supports verticalframe, sheet, resize, lowpart and combine", async () => {
        const c = compositor()
        const frame = await c.generate("strip.png^[verticalframe:4:2")
        expect([frame.width, frame.height]).toEqual([1, 1])
        expect(pixel(frame, 0, 0)).toEqual([0, 0, 255, 255])

        expect(pixel(await c.generate("quad.png^[sheet:2x2:1,0"), 0, 0)).toEqual([0, 255, 0, 255])

        const resized = await c.generate("quad.png^[resize:4x4")
        expect(resized.width).toBe(4)
        expect(pixel(resized, 3, 3)).toEqual([255, 255, 255, 255])

        // the lower half of the image is drawn at its own position, without scaling
        const lowpart = await c.generate("big.png^[lowpart:50:red.png")
        expect(pixel(lowpart, 0, 0)).toEqual([0, 0, 255, 255])
        expect(pixel(lowpart, 0, 1)).toEqual([255, 0, 0, 255])
        expect(pixel(lowpart, 2, 1)).toEqual([0, 0, 255, 255])

        const combined = await c.generate("[combine:4x2:0,0=red.png:2,0=quad.png\\^[transformFX")
        expect([combined.width, combined.height]).toEqual([4, 2])
        expect(pixel(combined, 0, 0)).toEqual([255, 0, 0, 255])
        expect(pixel(combined, 2, 0)).toEqual([0, 255, 0, 255])
        expect(pixel(combined, 3, 0)).toEqual([255, 0, 0, 255])
    })

    it("replaces missing textures by a placeholder", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const c = compositor()
        const missing = await c.generate("missing.png")
        expect([missing.width, missing.height]).toEqual([16, 16])
        expect(pixel(missing, 0, 0)).toEqual([255, 0, 255, 255])
        await c.generate("missing.png^[brighten")
        expect(warn).toHaveBeenCalledTimes(1)

        // built into the engine
        expect(pixel(await c.generate("blank.png"), 0, 0)).toEqual([0, 0, 0, 0])
        await c.generate("unknown_node.png")
        expect(warn).toHaveBeenCalledTimes(1)
        warn.mockRestore()
    })
})
