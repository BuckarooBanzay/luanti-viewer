import { describe, expect, it } from "vitest"
import { PLAYER_HEIGHT, collide, isFree, type SolidQuery } from "./physics.js"

/** a floor of nodes at y = 0 (top face at 0.5) and a wall at x = 5 */
const world: SolidQuery = { isSolid: (x, y) => y <= 0 || x === 5 }

describe("collide", () => {
    it("moves freely in the air", () => {
        const r = collide(world, 0, 2, 0, 1, 0.5, -1)
        expect([r.x, r.y, r.z]).toEqual([1, 2.5, -1])
        expect(r.onGround).toBe(false)
    })

    it("lands on the floor even with a large step", () => {
        const r = collide(world, 0, 3, 0, 0, -10, 0)
        expect(r.y).toBeCloseTo(0.5)
        expect(r.onGround).toBe(true)
        expect(r.hitY).toBe(true)
    })

    it("stays on the floor", () => {
        const r = collide(world, 0, 0.5, 0, 0, -0.1, 0)
        expect(r.y).toBeCloseTo(0.5)
        expect(r.onGround).toBe(true)
    })

    it("slides along a wall", () => {
        // the wall face is at x = 4.5, the half width 0.3
        const r = collide(world, 4, 0.5, 0, 2, 0, 1)
        expect(r.x).toBeCloseTo(4.2)
        expect(r.z).toBeCloseTo(1)
        expect(r.hitX).toBe(true)
        expect(r.hitZ).toBe(false)
    })

    it("stops at the wall from the other side", () => {
        const r = collide(world, 6, 0.5, 0, -3, 0, 0)
        expect(r.x).toBeCloseTo(5.8)
    })

    it("hits the ceiling with the top of the box", () => {
        const ceiling: SolidQuery = { isSolid: (_x, y) => y === 3 }
        const r = collide(ceiling, 0, 0.5, 0, 0, 5, 0)
        // the lower face of the node is at 2.5
        expect(r.y).toBeCloseTo(2.5 - PLAYER_HEIGHT)
        expect(r.hitY).toBe(true)
        expect(r.onGround).toBe(false)
    })

    it("does not catch on the edge of a node it only touches", () => {
        // standing next to the wall without overlapping it, walking along z
        const r = collide(world, 4.2, 0.5, 0, 0, 0, 3)
        expect(r.z).toBeCloseTo(3)
    })

    it("is blocked by a node at the corner of the box", () => {
        const pillar: SolidQuery = { isSolid: (x, y, z) => y <= 0 || (x === 1 && z === 1 && y === 1) }
        // box edge reaches into the pillar's column when moving to x = 0.8 (0.8 + 0.3 > 0.5 at z-range 0.7..1.3)
        const r = collide(pillar, 0, 0.5, 1, 1, 0, 0)
        expect(r.x).toBeCloseTo(0.2)
        expect(r.hitX).toBe(true)
    })
})

describe("isFree", () => {
    it("detects overlaps with solid nodes", () => {
        expect(isFree(world, 0, 0.5, 0)).toBe(true)
        expect(isFree(world, 0, 0.4, 0)).toBe(false)
        expect(isFree(world, 4.2, 0.5, 0)).toBe(true)
        expect(isFree(world, 4.3, 0.5, 0)).toBe(false)
    })
})
