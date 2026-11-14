import { describe, expect, it } from "vitest"
import { splitFrames } from "./materials.js"
import { MeshBuffer } from "./mesh/mesher.js"
import { createImage } from "./texture/compositor.js"
import { createGeometry } from "./view.js"

describe("createGeometry", () => {
    it("converts the left-handed output of the mesher for three.js", () => {
        const buffer = new MeshBuffer()
        // top face of a node as emitted by the mesher
        buffer.positions.push(-0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5)
        buffer.uvs.push(0, 0, 1, 0, 1, 1, 0, 1)
        buffer.colors.push(...new Array(12).fill(1))
        buffer.indices.push(0, 1, 2, 2, 3, 0)

        const geometry = createGeometry(buffer)
        const position = geometry.getAttribute("position").array
        const index = geometry.getIndex()!.array
        // x is mirrored, v is flipped
        expect([...position.slice(0, 3)]).toEqual([0.5, 0.5, 0.5])
        expect([...geometry.getAttribute("uv").array]).toEqual([0, 1, 1, 1, 1, 0, 0, 0])

        // counterclockwise front faces in a right-handed system: (b - a) x (c - a) points up
        for (let t = 0; t < index.length; t += 3) {
            const [a, b, c] = [0, 1, 2].map(i => [...position.slice(index[t + i]! * 3, index[t + i]! * 3 + 3)]) as [number[], number[], number[]]
            const u = b.map((v, i) => v - a[i]!), v = c.map((w, i) => w - a[i]!)
            expect(u[2]! * v[0]! - u[0]! * v[2]!).toBeGreaterThan(0)
        }
        expect(geometry.boundingSphere!.radius).toBeCloseTo(Math.SQRT1_2)
    })
})

describe("splitFrames", () => {
    const spec = { texture: "a.png", backfaceCulling: true, alpha: "opaque" } as const

    it("returns the whole image for tiles without animation", () => {
        const { frames, frameLength } = splitFrames(createImage(16, 64), spec)
        expect(frames).toHaveLength(1)
        expect(frameLength).toBe(0)
    })

    it("splits vertical frames by the aspect ratio", () => {
        const image = createImage(16, 64)
        image.data[(32 * 16) * 4] = 200 // first pixel of the third frame
        const { frames, frameLength } = splitFrames(image, { ...spec, animation: { type: "vertical_frames", aspect_w: 16, aspect_h: 16, length: 2 } })
        expect(frames).toHaveLength(4)
        expect(frames[2]!.height).toBe(16)
        expect(frames[2]!.data[0]).toBe(200)
        expect(frameLength).toBe(0.5)
    })

    it("splits 2d sheets row by row", () => {
        const image = createImage(32, 32)
        image.data[(16 * 32) * 4] = 200 // first pixel of the second row
        const { frames, frameLength } = splitFrames(image, { ...spec, animation: { type: "sheet_2d", frames_w: 2, frames_h: 2, frame_length: 0.25 } })
        expect(frames).toHaveLength(4)
        expect(frames[2]!.data[0]).toBe(200)
        expect(frameLength).toBe(0.25)
    })
})
