import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseB3d } from "./b3d"
import type { ModelBuffer } from "./model"
import { parseObj } from "./obj"

/** geometric normal of a triangle by the convention of the engine: (b - a) x (c - a) */
function triangleNormal(buffer: ModelBuffer, triangle: number): number[] {
    const [a, b, c] = [0, 1, 2].map(i => {
        const o = buffer.indices[triangle * 3 + i]! * 3
        return [buffer.positions[o]!, buffer.positions[o + 1]!, buffer.positions[o + 2]!]
    }) as [number[], number[], number[]]
    const u = b.map((v, i) => v - a[i]!), v = c.map((w, i) => w - a[i]!)
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
    const length = Math.hypot(...n)
    return n.map(x => Math.round(x / length) + 0)
}

function bounds(buffers: ModelBuffer[]) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (const buffer of buffers) {
        buffer.positions.forEach((v, i) => {
            min[i % 3] = Math.min(min[i % 3]!, v)
            max[i % 3] = Math.max(max[i % 3]!, v)
        })
    }
    return { min, max }
}

describe("parseObj", () => {
    // a quad on top of the node (counterclockwise seen from above) and one on the +x side
    const obj = `
# comment
o test
v -0.5 0.5 -0.5
v -0.5 0.5 0.5
v 0.5 0.5 0.5
v 0.5 0.5 -0.5
v 0.5 -0.5 0.5
v 0.5 -0.5 -0.5
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 1 0
vn 1 0 0
g top
f 1/1/1 2/2/1 3/3/1 4/4/1
g side
s off
f -3/1/2 -2/2/2 -1/3/2
`

    it("creates a buffer per group in order of first use", () => {
        const model = parseObj(obj)
        expect(model.buffers).toHaveLength(2)
        expect(model.buffers[0]!.indices).toHaveLength(6)
        expect(model.buffers[1]!.indices).toHaveLength(3)
    })

    it("converts to the left-handed convention of the engine", () => {
        const [top, side] = parseObj(obj).buffers as [ModelBuffer, ModelBuffer]
        // x is mirrored, v is flipped
        expect([...top.positions.slice(0, 3)]).toEqual([0.5, 0.5, -0.5])
        expect([...top.uvs.slice(0, 4)]).toEqual([0, 1, 1, 1])
        expect([...top.normals.slice(0, 3)].map(v => v + 0)).toEqual([0, 1, 0])
        // the faces still point outwards
        expect(triangleNormal(top, 0)).toEqual([0, 1, 0])
        expect(triangleNormal(top, 1)).toEqual([0, 1, 0])
        expect([...side.normals.slice(0, 3)]).toEqual([-1, 0, 0])
        expect(triangleNormal(side, 0)).toEqual([-1, 0, 0])
    })

    it("computes normals if the file has none", () => {
        const model = parseObj("v 0 0 0\nv 0 0 1\nv 1 0 1\nf 1 2 3\n")
        expect([...model.buffers[0]!.normals.slice(0, 3)].map(v => v + 0)).toEqual([0, 1, 0])
        expect([...model.buffers[0]!.uvs]).toEqual([0, 0, 0, 0, 0, 0])
    })

    it("rejects invalid faces", () => {
        expect(() => parseObj("v 0 0 0\nf 1 2 3\n")).toThrow(/invalid vertex index/)
        expect(() => parseObj("v 0 0 0\nv 1 0 0\nf 1 2\n")).toThrow(/too few vertices/)
    })
})

/** builds a b3d file with a single node and mesh */
function buildB3d(options: { scale: number, rotation: number[], vertices: number[][], triangles: number[][], bone?: boolean }): ArrayBuffer {
    const chunk = (tag: string, ...parts: Uint8Array[]) => {
        const length = parts.reduce((sum, p) => sum + p.length, 0)
        const result = new Uint8Array(8 + length)
        result.set([...tag].map(c => c.charCodeAt(0)))
        new DataView(result.buffer).setInt32(4, length, true)
        let offset = 8
        for (const part of parts) {
            result.set(part, offset)
            offset += part.length
        }
        return result
    }
    const ints = (...values: number[]) => new Uint8Array(new Int32Array(values).buffer)
    const floats = (...values: number[]) => new Uint8Array(new Float32Array(values).buffer)

    const vrts = chunk("VRTS", ints(0, 1, 2), ...options.vertices.map(v => floats(...v)))
    const tris = chunk("TRIS", ints(-1), ...options.triangles.map(t => ints(...t)))
    const mesh = chunk("MESH", ints(-1), vrts, tris)
    const name = new Uint8Array([..."door", "\0"].map(c => c.charCodeAt(0)))
    const transform = floats(0, 0, 0, options.scale, options.scale, options.scale, ...options.rotation)
    const parts = [name, transform, mesh]
    if (options.bone) {
        parts.push(chunk("BONE"))
    }
    const file = chunk("BB3D", ints(1), chunk("TEXS"), chunk("NODE", ...parts))
    return file.buffer as ArrayBuffer
}

describe("parseB3d", () => {
    // like the doors of minetest_game: modelled lying on the back, scaled by 1/16 and rotated upright
    const door = {
        scale: 1 / 16,
        rotation: [Math.SQRT1_2, Math.SQRT1_2, 0, 0],
        // x, y, z, u, v
        vertices: [[-8, 6, -8, 0, 1], [8, 6, -8, 1, 1], [8, 6, 24, 1, 0], [-8, 6, 24, 0, 0]],
        triangles: [[0, 1, 2], [2, 3, 0]]
    }

    it("applies the transformation of the node", () => {
        const model = parseB3d(buildB3d(door))
        expect(model.buffers).toHaveLength(1)
        const buffer = model.buffers[0]!
        expect(buffer.indices).toHaveLength(6)
        expect([...buffer.uvs.slice(0, 2)]).toEqual([0, 1])
        // two nodes high, at the front (-z) of the node
        const { min, max } = bounds(model.buffers)
        expect(min.map(v => +v.toFixed(4))).toEqual([-0.5, -0.5, -0.375])
        expect(max.map(v => +v.toFixed(4))).toEqual([0.5, 1.5, -0.375])
        // normals are computed if the file has none
        expect([...buffer.normals.slice(0, 3)].map(v => Math.round(v) + 0)).toEqual(triangleNormal(buffer, 0))
    })

    it("does not scale animated meshes to node size", () => {
        const { max } = bounds(parseB3d(buildB3d({ ...door, bone: true })).buffers)
        expect(+max[1]!.toFixed(4)).toBe(0.15)
    })

    it("rejects invalid files", () => {
        expect(() => parseB3d(new ArrayBuffer(4))).toThrow(/BB3D/)
        expect(() => parseB3d(buildB3d({ ...door, triangles: [[0, 1, 9]] }))).toThrow(/unknown vertex/)
    })
})

// the models of minetest_game are only available if the submodule is checked out
const modelDirs = [
    join(__dirname, "../../minetest_game/mods/doors/models"),
    join(__dirname, "../../minetest_game/mods/default/models")
]
describe.skipIf(!modelDirs.every(existsSync))("minetest_game models", () => {
    it("parses door_a.b3d", () => {
        const file = readFileSync(join(modelDirs[0]!, "door_a.b3d"))
        const model = parseB3d(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer)
        const { min, max } = bounds(model.buffers)
        expect(min.map(v => +v.toFixed(2))).toEqual([-0.5, -0.5, -0.5])
        expect(max.map(v => +v.toFixed(2))).toEqual([0.5, 1.5, -0.37])
    })

    it("parses chest_open.obj and torch_wall.obj", () => {
        const chest = parseObj(readFileSync(join(modelDirs[1]!, "chest_open.obj"), "utf-8"))
        // one buffer per tile: top, bottom, right/left, back, front, inside
        expect(chest.buffers).toHaveLength(6)
        const { min, max } = bounds(chest.buffers)
        expect(min.map(v => +v.toFixed(2))).toEqual([-0.5, -0.5, -0.5])
        expect(max[0]).toBeCloseTo(0.5)

        const torch = parseObj(readFileSync(join(modelDirs[1]!, "torch_wall.obj"), "utf-8"))
        expect(torch.buffers).toHaveLength(1)
    })
})
