import { describe, expect, it } from "vitest"
import { STICK_RADIUS, applyLook, stickVector } from "./touch.js"

describe("stickVector", () => {
    it("does not move in the dead zone", () => {
        expect(stickVector(0, 0)).toEqual({ forward: 0, right: 0 })
        expect(stickVector(3, -4)).toEqual({ forward: 0, right: 0 })
    })

    it("moves forward when dragged up and right when dragged right", () => {
        expect(stickVector(0, -STICK_RADIUS)).toEqual({ forward: 1, right: 0 })
        expect(stickVector(0, STICK_RADIUS)).toEqual({ forward: -1, right: 0 })
        expect(stickVector(STICK_RADIUS, 0)).toEqual({ forward: 0, right: 1 })
    })

    it("is analog between the dead zone and the radius", () => {
        const half = stickVector(0, -STICK_RADIUS * 0.575).forward
        expect(half).toBeCloseTo(0.5)
    })

    it("is not faster beyond the radius or on the diagonal", () => {
        expect(stickVector(0, -STICK_RADIUS * 3).forward).toBeCloseTo(1)
        const { forward, right } = stickVector(200, -200)
        expect(Math.hypot(forward, right)).toBeCloseTo(1)
        expect(forward).toBeCloseTo(right)
    })

    it("respects a custom radius", () => {
        expect(stickVector(10, 0, 10)).toEqual({ forward: 0, right: 1 })
    })
})

describe("applyLook", () => {
    it("turns right when dragged right and looks down when dragged down", () => {
        const { yaw, pitch } = applyLook(0, 0, 10, 20)
        expect(yaw).toBeLessThan(0)
        expect(pitch).toBeLessThan(0)
        expect(pitch).toBeCloseTo(yaw * 2)
    })

    it("does not flip over at the poles", () => {
        expect(applyLook(0, 0, 0, -1e6).pitch).toBeLessThan(Math.PI / 2)
        expect(applyLook(0, 0, 0, 1e6).pitch).toBeGreaterThan(-Math.PI / 2)
    })

    it("does not limit the yaw", () => {
        expect(applyLook(0, 0, -1e4, 0).yaw).toBeGreaterThan(Math.PI * 2)
    })
})
