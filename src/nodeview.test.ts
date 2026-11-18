import { describe, expect, it } from "vitest"
import { NodeRegistry, type TileSpec } from "./mesh/nodes.js"
import { defaultParam2, fitDistance, meshNode } from "./nodeview.js"
import type { NodeDefinition } from "./types.js"

const base = { paramtype: "none", paramtype2: "none", light_source: 0, groups: null } as const

function registry(def: NodeDefinition) {
    const tiles: TileSpec[] = []
    const nodes = new NodeRegistry(async name => name === def.name ? def : null, {
        getTile: spec => tiles.push(spec) - 1
    })
    return nodes
}

function bounds(buffers: Map<number, { positions: number[] }>) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (const { positions } of buffers.values()) {
        for (let i = 0; i < positions.length; i++) {
            min[i % 3] = Math.min(min[i % 3]!, positions[i]!)
            max[i % 3] = Math.max(max[i % 3]!, positions[i]!)
        }
    }
    return { min, max }
}

describe("meshNode", () => {
    it("draws all six faces of a full node around the origin", async () => {
        const def: NodeDefinition = { ...base, name: "stone", drawtype: "normal", tiles: ["stone.png"] }
        const nodes = registry(def)
        await nodes.ensure(["air", "stone"])
        const buffers = meshNode(nodes, "stone")
        const quads = [...buffers.values()].reduce((sum, b) => sum + b.indices.length / 6, 0)
        expect(quads).toBe(6)
        expect(bounds(buffers)).toEqual({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] })
    })

    it("applies param2", async () => {
        const def: NodeDefinition = {
            ...base, name: "slab", drawtype: "nodebox", paramtype: "light", paramtype2: "facedir", tiles: ["wood.png"],
            node_box: { type: "fixed", fixed: [-0.5, -0.5, -0.5, 0.5, 0, 0.5] }
        }
        const nodes = registry(def)
        await nodes.ensure(["air", "slab"])
        expect(bounds(meshNode(nodes, "slab")).max[1]).toBeCloseTo(0)
        // facedir 20: upside down
        expect(bounds(meshNode(nodes, "slab", 20)).min[1]).toBeCloseTo(0)
    })

    it("returns nothing for invisible nodes", async () => {
        const def: NodeDefinition = { ...base, name: "barrier", drawtype: "airlike" }
        const nodes = registry(def)
        await nodes.ensure(["air", "barrier"])
        expect(meshNode(nodes, "barrier").size).toBe(0)
    })
})

describe("fitDistance", () => {
    it("fits the sphere into the narrower field of view", () => {
        const square = fitDistance(1, 60, 1)
        // sin(30°) = 0.5, times the margin
        expect(square).toBeGreaterThan(2)
        expect(square).toBeLessThan(2.5)
        // wider: limited by the vertical fov as well
        expect(fitDistance(1, 60, 2)).toBeCloseTo(square)
        // portrait: the horizontal fov is narrower, the camera moves back
        expect(fitDistance(1, 60, 0.5)).toBeGreaterThan(square)
        expect(fitDistance(2, 60, 1)).toBeCloseTo(square * 2)
    })
})

describe("defaultParam2", () => {
    it("puts wallmounted nodes on the floor", () => {
        expect(defaultParam2({ ...base, name: "torch", drawtype: "torchlike", paramtype2: "wallmounted" })).toBe(1)
        expect(defaultParam2({ ...base, name: "sign", drawtype: "signlike", paramtype2: "colorwallmounted" })).toBe(1)
        expect(defaultParam2({ ...base, name: "chest", drawtype: "normal", paramtype2: "facedir" })).toBe(0)
    })
})
