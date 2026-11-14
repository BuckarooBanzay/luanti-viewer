import { describe, expect, it } from "vitest"
import { MapblockLoader, type Bounds } from "./loader"
import type { MapblockPosition } from "./types"

const key = (pos: MapblockPosition) => `${pos.x},${pos.y},${pos.z}`
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** loader with fetches that are resolved by the test */
function setup(viewRange: number, bounds: Bounds | null = null, absent: string[] = [], cacheSize = 0) {
    const pending = new Map<string, () => void>()
    const requested: string[] = []
    const stored = new Set<string>()
    const meshed = new Set<string>()
    const loader = new MapblockLoader<string, string>({
        viewRange,
        bounds,
        concurrency: 10000,
        cacheSize,
        fetch: pos => new Promise(resolve => {
            requested.push(key(pos))
            pending.set(key(pos), () => resolve(absent.includes(key(pos)) ? null : key(pos)))
        }),
        store: pos => {
            stored.add(key(pos))
        },
        unload: pos => {
            expect(stored.delete(key(pos))).toBe(true)
        },
        mesh: pos => {
            expect(meshed.has(key(pos))).toBe(false)
            meshed.add(key(pos))
            return key(pos)
        },
        unmesh: mesh => {
            expect(meshed.delete(mesh)).toBe(true)
        }
    })
    const resolve = async (filter: (k: string) => boolean = () => true) => {
        for (const [k, done] of [...pending]) {
            if (filter(k)) {
                pending.delete(k)
                done()
            }
        }
        await flush()
        loader.processMeshes(() => true)
    }
    return { loader, pending, requested, stored, meshed, resolve }
}

describe("MapblockLoader", () => {
    it("loads the data one mapblock further than the meshes", async () => {
        const { loader, requested, stored, meshed, resolve } = setup(1)
        expect(loader.setCenter({ x: 0, y: 0, z: 0 })).toBe(true)
        expect(loader.setCenter({ x: 0, y: 0, z: 0 })).toBe(false)
        // the 6 face neighbors are in range, the corners of the 5x5x5 cube are not adjacent to any of them
        expect(requested).toHaveLength(81)
        expect(requested[0]).toBe("0,0,0")
        expect(requested).toContain("2,1,1")
        expect(requested).not.toContain("2,2,0")
        expect(loader.stats()).toEqual({ fetching: 81, meshing: 7 })

        await resolve()
        expect(stored.size).toBe(81)
        expect([...meshed].sort()).toEqual(["-1,0,0", "0,-1,0", "0,0,-1", "0,0,0", "0,0,1", "0,1,0", "1,0,0"])
        expect(loader.stats()).toEqual({ fetching: 0, meshing: 0 })
    })

    it("waits for all neighbors before a mapblock is meshed", async () => {
        const { loader, meshed, resolve } = setup(1)
        loader.setCenter({ x: 0, y: 0, z: 0 })
        await resolve(k => k !== "1,1,1")
        expect([...meshed].sort()).toEqual(["-1,0,0", "0,-1,0", "0,0,-1"])
        await resolve()
        expect(meshed.size).toBe(7)
    })

    it("treats missing mapblocks as resolved neighbors", async () => {
        const { loader, stored, meshed, resolve } = setup(1, null, ["0,0,0", "1,1,1"])
        loader.setCenter({ x: 0, y: 0, z: 0 })
        await resolve()
        expect(stored.has("0,0,0")).toBe(false)
        expect(meshed.size).toBe(6)
        expect(loader.stats()).toEqual({ fetching: 0, meshing: 0 })
    })

    it("stays within the bounds", async () => {
        const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } }
        const { loader, requested, meshed, resolve } = setup(Infinity, bounds)
        loader.setCenter({ x: 0.5, y: 0, z: 0 })
        expect(requested.sort()).toEqual(["0,0,0", "1,0,0"])
        await resolve()
        expect(meshed.size).toBe(2)
        expect(() => setup(Infinity)).toThrow()
    })

    it("keeps mapblocks slightly out of range and unloads the distant ones", async () => {
        const { loader, stored, meshed, resolve } = setup(1)
        loader.setCenter({ x: 0, y: 0, z: 0 })
        await resolve()

        loader.setCenter({ x: 2, y: 0, z: 0 })
        await resolve()
        // distance 3: still meshed, the data of its neighbors is kept as well
        expect(meshed.has("-1,0,0")).toBe(true)
        expect(stored.has("-2,1,1")).toBe(true)
        expect(meshed.has("3,0,0")).toBe(true)

        loader.setCenter({ x: 3, y: 0, z: 0 })
        await resolve()
        expect(meshed.has("-1,0,0")).toBe(false)
        expect(meshed.has("0,0,0")).toBe(true)
        expect(stored.has("-2,1,1")).toBe(false)
        expect(stored.has("-1,0,0")).toBe(true)

        loader.setCenter({ x: 100, y: 0, z: 0 })
        await resolve()
        expect(meshed.size).toBe(7)
        expect(stored.size).toBe(81)
        expect(meshed.has("100,0,0")).toBe(true)
    })

    it("drops the results of mapblocks that left the range", async () => {
        const { loader, stored, meshed, resolve } = setup(1)
        loader.setCenter({ x: 0, y: 0, z: 0 })
        loader.setCenter({ x: 100, y: 0, z: 0 })
        await resolve()
        expect(stored.has("0,0,0")).toBe(false)
        expect(stored.size).toBe(81)
        expect(meshed.size).toBe(7)
    })

    it("reuses the data of unloaded mapblocks", async () => {
        const { loader, requested, stored, meshed, resolve } = setup(1, null, ["0,1,0"], 1000)
        loader.setCenter({ x: 0, y: 0, z: 0 })
        await resolve()
        loader.setCenter({ x: 100, y: 0, z: 0 })
        await resolve()
        expect(stored.has("0,0,0")).toBe(false)
        expect(requested).toHaveLength(162)

        // back again: nothing is fetched, missing mapblocks are remembered as well
        loader.setCenter({ x: 0, y: 0, z: 0 })
        expect(requested).toHaveLength(162)
        expect(loader.stats().fetching).toBe(0)
        expect(stored.has("0,0,0")).toBe(true)
        loader.processMeshes(() => true)
        expect(meshed.has("0,0,0")).toBe(true)
        expect(meshed.has("0,1,0")).toBe(false)
        expect(meshed.size).toBe(6)
    })

    it("caches results that arrive after the mapblock left the range", async () => {
        const { loader, requested, resolve } = setup(1, null, [], 1000)
        loader.setCenter({ x: 0, y: 0, z: 0 })
        loader.setCenter({ x: 100, y: 0, z: 0 })
        await resolve()
        loader.setCenter({ x: 0, y: 0, z: 0 })
        expect(requested).toHaveLength(162)
    })

    it("evicts the least recently unloaded mapblocks", async () => {
        const { loader, requested, resolve } = setup(1, null, [], 10)
        loader.setCenter({ x: 0, y: 0, z: 0 })
        await resolve()
        loader.setCenter({ x: 100, y: 0, z: 0 })
        await resolve()
        loader.setCenter({ x: 0, y: 0, z: 0 })
        expect(requested).toHaveLength(162 + 81 - 10)
    })

    it("limits the parallel fetches and starts with the highest priority", async () => {
        const requested: string[] = []
        const loader = new MapblockLoader<string, null>({
            viewRange: 1, bounds: null, concurrency: 2,
            fetch: async pos => {
                requested.push(key(pos))
                return key(pos)
            },
            store: () => {}, unload: () => {}, mesh: () => null, unmesh: () => {},
            priority: pos => -pos.x
        })
        loader.setCenter({ x: 0, y: 0, z: 0 })
        expect(requested).toHaveLength(2)
        expect(requested.every(k => k.startsWith("2,"))).toBe(true)
        await flush()
        expect(requested).toHaveLength(81)
    })

    it("removes the meshes on dispose", async () => {
        const { loader, meshed, resolve } = setup(1)
        loader.setCenter({ x: 0, y: 0, z: 0 })
        await resolve()
        loader.dispose()
        expect(meshed.size).toBe(0)
    })
})
