import { describe, expect, it } from "vitest"
import { MAPBLOCK_VOLUME, ParsedMapblock, getNodeIndex } from "./mapblock.js"
import { createNeighborhood, paddedIndex } from "./mesh/mesher.js"
import { CONTENT_IGNORE, NodeRegistry } from "./mesh/nodes.js"
import { World } from "./world.js"

function createBlock(names: string[], fill: (x: number, y: number, z: number) => [id: number, param1: number, param2: number]) {
    const ids = new Uint16Array(MAPBLOCK_VOLUME), param1 = new Uint8Array(MAPBLOCK_VOLUME), param2 = new Uint8Array(MAPBLOCK_VOLUME)
    for (let z = 0; z < 16; z++) {
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                const i = getNodeIndex(x, y, z);
                [ids[i], param1[i], param2[i]] = fill(x, y, z)
            }
        }
    }
    // content ids of the export: arbitrary numbers per mapblock
    return new ParsedMapblock(ids.map(id => id + 100), param1, param2, new Map(names.map((name, i) => [i + 100, name])))
}

describe("World", () => {
    const nodes = new NodeRegistry(async () => null, { getTile: () => 0 })
    const world = new World(nodes)
    world.set({ x: 0, y: 0, z: 0 }, createBlock(["air", "a", "b"], (x, y, z) => [x === 15 ? 1 : y === 0 ? 2 : 0, x, z]))
    world.set({ x: 1, y: 0, z: 0 }, createBlock(["b", "c"], x => [x === 0 ? 1 : 0, 7, 9]))
    world.set({ x: -1, y: -1, z: -1 }, createBlock(["c"], () => [0, 3, 4]))

    it("knows the loaded mapblocks", () => {
        expect(world.size).toBe(3)
        expect(world.has({ x: 1, y: 0, z: 0 })).toBe(true)
        expect(world.has({ x: 0, y: 1, z: 0 })).toBe(false)
    })

    it("translates the content ids of the mapblocks", () => {
        const nb = createNeighborhood()
        world.fillNeighborhood({ x: 0, y: 0, z: 0 }, nb)
        const name = (x: number, y: number, z: number) => nodes.infos[nb.ids[paddedIndex(x, y, z)]!]!.name
        expect(name(15, 5, 5)).toBe("a")
        expect(name(3, 0, 5)).toBe("b")
        expect(name(3, 5, 5)).toBe("air")
        expect(nb.param1[paddedIndex(3, 5, 9)]).toBe(3)
        expect(nb.param2[paddedIndex(3, 5, 9)]).toBe(9)
    })

    it("reports solid nodes across mapblock borders", async () => {
        const registry = new NodeRegistry(async name => ({
            name, drawtype: "normal", paramtype: "none", paramtype2: "none", light_source: 0, groups: null,
            walkable: name === "air" ? false : name !== "ghost"
        }), { getTile: () => 0 })
        await registry.ensure(["air", "stone", "ghost"])
        const w = new World(registry)
        w.set({ x: 0, y: 0, z: 0 }, createBlock(["air", "stone", "ghost"], (x, y) => [y === 0 ? 1 : x === 3 ? 2 : 0, 0, 0]))
        expect(w.isSolid(5, 0, 5)).toBe(true)
        expect(w.isSolid(5, 1, 5)).toBe(false)
        // not walkable
        expect(w.isSolid(3, 1, 5)).toBe(false)
        // not loaded
        expect(w.isSolid(16, 0, 0)).toBe(true)
        expect(w.isSolid(-1, 0, 0)).toBe(true)

        // obstacles of the flying camera: the same nodes, but nothing outside of the loaded mapblocks
        expect(w.isObstacle(5, 0, 5)).toBe(true)
        expect(w.isObstacle(5, 1, 5)).toBe(false)
        expect(w.isObstacle(3, 1, 5)).toBe(false)
        expect(w.isObstacle(16, 0, 0)).toBe(false)
        expect(w.isObstacle(-1, 0, 0)).toBe(false)
    })

    it("copies the adjacent nodes of the neighbors", () => {
        const nb = createNeighborhood()
        world.fillNeighborhood({ x: 0, y: 0, z: 0 }, nb)
        const name = (x: number, y: number, z: number) => nodes.infos[nb.ids[paddedIndex(x, y, z)]!]!.name
        // face neighbor at x+
        expect(name(16, 4, 4)).toBe("c")
        expect(nb.param1[paddedIndex(16, 4, 4)]).toBe(7)
        expect(nb.param2[paddedIndex(16, 15, 0)]).toBe(9)
        // corner neighbor
        expect(name(-1, -1, -1)).toBe("c")
        expect(nb.param1[paddedIndex(-1, -1, -1)]).toBe(3)
        // not loaded
        expect(nb.ids[paddedIndex(-1, 4, 4)]).toBe(CONTENT_IGNORE)
        expect(nb.ids[paddedIndex(4, 16, 4)]).toBe(CONTENT_IGNORE)
        expect(nb.ids[paddedIndex(-1, -1, 0)]).toBe(CONTENT_IGNORE)
    })

    it("removes mapblocks", () => {
        const other = new World(nodes)
        other.set({ x: 0, y: 0, z: 0 }, createBlock(["air"], () => [0, 0, 0]))
        other.delete({ x: 0, y: 0, z: 0 })
        expect(other.size).toBe(0)
        expect(other.has({ x: 0, y: 0, z: 0 })).toBe(false)
    })

    it("resets the arrays between calls", () => {
        const nb = createNeighborhood()
        world.fillNeighborhood({ x: 0, y: 0, z: 0 }, nb)
        world.fillNeighborhood({ x: 5, y: 5, z: 5 }, nb)
        expect(nb.ids.every(id => id === CONTENT_IGNORE)).toBe(true)
    })
})
