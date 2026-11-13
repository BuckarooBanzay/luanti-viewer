import { describe, expect, it } from "vitest"
import { applyMat3, facedirMatrix, FACEDIR_TILES, WALLMOUNTED_TO_FACEDIR, type Mat3 } from "./rotation"

const DIRECTIONS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const dirIndex = (d: number[]) => (d[0]! + 2 * d[1]! + 3 * d[2]!) & 7
const rotate = (m: Mat3, v: number[]) => {
    const result = [...v]
    applyMat3(m, result)
    return result.map(Math.round)
}
const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]

describe("facedirMatrix", () => {
    it("is the identity for facedir 0", () => {
        expect(rotate(facedirMatrix(0), [1, 2, 3])).toEqual([1, 2, 3])
    })

    it("turns the front of a node towards the placer", () => {
        // facedir 1: the back faces east (+x), the front (-z) west
        expect(rotate(facedirMatrix(1), [0, 0, -1])).toEqual([-1, 0, 0])
        expect(rotate(facedirMatrix(2), [0, 0, -1])).toEqual([0, 0, 1])
        expect(rotate(facedirMatrix(3), [0, 0, -1])).toEqual([1, 0, 0])
    })

    it("moves the top of the node along the axis direction", () => {
        const up = [0, 1, 0]
        expect(rotate(facedirMatrix(4), up)).toEqual([0, 0, 1]) // z+
        expect(rotate(facedirMatrix(8), up)).toEqual([0, 0, -1]) // z-
        expect(rotate(facedirMatrix(12), up)).toEqual([1, 0, 0]) // x+
        expect(rotate(facedirMatrix(16), up)).toEqual([-1, 0, 0]) // x-
        expect(rotate(facedirMatrix(20), up)).toEqual([0, -1, 0]) // y-
    })

    it("yields 24 distinct proper rotations", () => {
        const seen = new Set<string>()
        for (let facedir = 0; facedir < 24; facedir++) {
            const m = facedirMatrix(facedir)
            const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
            expect(det).toBe(1)
            seen.add(m.join(","))
        }
        expect(seen.size).toBe(24)
    })

    it("agrees with the tile table of the engine", () => {
        // the tile on a world face has to be the tile of the unrotated face that was moved there
        for (let facedir = 0; facedir < 24; facedir++) {
            const inverse = transpose(facedirMatrix(facedir))
            for (const direction of DIRECTIONS) {
                const local = rotate(inverse, direction)
                const expected = FACEDIR_TILES[0]![dirIndex(local)]![0]
                expect(FACEDIR_TILES[facedir]![dirIndex(direction)]![0], `facedir ${facedir}, direction ${direction}`).toBe(expected)
            }
        }
    })

    it("maps wallmounted directions to facedirs whose bottom points to the wall", () => {
        const walls = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
        walls.forEach((wall, param2) => {
            expect(rotate(facedirMatrix(WALLMOUNTED_TO_FACEDIR[param2]!), [0, -1, 0])).toEqual(wall)
        })
    })
})
