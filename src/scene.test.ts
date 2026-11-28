import { describe, expect, it } from "vitest"
import { screenshotSize } from "./scene.js"

describe("screenshotSize", () => {
    it("defaults to the size of the view times the pixel ratio", () => {
        expect(screenshotSize({}, 800, 600, 1, 4096)).toEqual({ width: 800, height: 600 })
        expect(screenshotSize({}, 801, 601, 1.5, 4096)).toEqual({ width: 1202, height: 902 })
    })

    it("derives a missing dimension from the aspect ratio of the view", () => {
        expect(screenshotSize({ width: 1920 }, 800, 450, 2, 4096)).toEqual({ width: 1920, height: 1080 })
        expect(screenshotSize({ height: 300 }, 800, 600, 2, 4096)).toEqual({ width: 400, height: 300 })
    })

    it("keeps an explicit size with another aspect ratio", () => {
        expect(screenshotSize({ width: 512, height: 512 }, 800, 600, 1, 4096)).toEqual({ width: 512, height: 512 })
    })

    it("rejects invalid sizes", () => {
        expect(() => screenshotSize({ width: 0 }, 800, 600, 1, 4096)).toThrow(/invalid/)
        expect(() => screenshotSize({ width: 10.5, height: 10 }, 800, 600, 1, 4096)).toThrow(/invalid/)
        expect(() => screenshotSize({ width: NaN }, 800, 600, 1, 4096)).toThrow(/invalid/)
    })

    it("rejects sizes above the limit of the renderer", () => {
        expect(() => screenshotSize({ width: 8192 }, 800, 600, 1, 4096)).toThrow(/too large/)
    })
})
