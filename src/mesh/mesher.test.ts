import { describe, expect, it } from "vitest"
import type { NodeDefinition } from "../types"
import { createNeighborhood, MapblockMesher, MeshBuffer, paddedIndex, type Neighborhood } from "./mesher"
import { CONTENT_IGNORE, NodeRegistry, type TileSpec } from "./nodes"

const base = { paramtype: "none", paramtype2: "none", light_source: 0, groups: null } as const
const light = { ...base, paramtype: "light" } as const

const definitions: NodeDefinition[] = [
    { ...light, name: "air", drawtype: "airlike" },
    { ...base, name: "stone", drawtype: "normal", tiles: ["stone.png"] },
    { ...base, name: "grass", drawtype: "normal", tiles: ["top.png", "bottom.png", "side.png"] },
    { ...base, name: "furnace", drawtype: "normal", paramtype2: "facedir", tiles: ["t.png", "t.png", "s.png", "s.png", "s.png", "front.png"] },
    { ...light, name: "glass", drawtype: "glasslike", tiles: ["glass.png"] },
    { ...light, name: "framed", drawtype: "glasslike_framed", tiles: ["frame.png", "detail.png"] },
    { ...light, name: "leaves", drawtype: "allfaces_optional", tiles: ["leaves.png"] },
    { ...light, name: "plant", drawtype: "plantlike", tiles: ["plant.png"], visual_scale: 2 },
    { ...light, name: "wheat", drawtype: "plantlike", paramtype2: "meshoptions", tiles: ["wheat.png"] },
    { ...base, name: "kelp", drawtype: "plantlike_rooted", paramtype2: "leveled", tiles: ["sand.png"], special_tiles: ["kelp.png"] },
    { ...light, name: "torch", drawtype: "torchlike", paramtype2: "wallmounted", tiles: ["floor.png", "ceiling.png", "wall.png"] },
    { ...light, name: "sign", drawtype: "signlike", paramtype2: "wallmounted", tiles: ["sign.png"] },
    { ...light, name: "fire", drawtype: "firelike", tiles: ["fire.png"], light_source: 13 },
    { ...light, name: "oldfence", drawtype: "fencelike", tiles: ["wood.png"] },
    { ...light, name: "rail", drawtype: "raillike", tiles: ["straight.png", "curved.png", "junction.png", "cross.png"], groups: { connect_to_raillike: 1 } },
    { ...light, name: "slab", drawtype: "nodebox", paramtype2: "facedir", tiles: ["wood.png"], node_box: { type: "fixed", fixed: [-0.5, -0.5, -0.5, 0.5, 0, 0.5] } },
    {
        ...light, name: "fence", drawtype: "nodebox", tiles: ["wood.png"], groups: { fence: 1 }, connects_to: ["group:fence", "stone"],
        node_box: {
            type: "connected",
            fixed: [-0.125, -0.5, -0.125, 0.125, 0.5, 0.125],
            connect_front: [[-0.0625, 0, -0.5, 0.0625, 0.25, -0.125]],
            connect_back: [[-0.0625, 0, 0.125, 0.0625, 0.25, 0.5]],
            connect_left: [[-0.5, 0, -0.0625, -0.125, 0.25, 0.0625]],
            connect_right: [[0.125, 0, -0.0625, 0.5, 0.25, 0.0625]]
        }
    },
    { ...light, name: "wallsign", drawtype: "nodebox", paramtype2: "wallmounted", tiles: ["sign.png"], node_box: { type: "wallmounted", wall_top: [-0.4, 0.4, -0.3, 0.4, 0.5, 0.3], wall_bottom: [-0.4, -0.5, -0.3, 0.4, -0.4, 0.3], wall_side: [-0.5, -0.3, -0.4, -0.4, 0.3, 0.4] } },
    { ...light, name: "water_source", drawtype: "liquid", tiles: ["water.png"], use_texture_alpha: "blend", liquid_alternative_source: "water_source", liquid_alternative_flowing: "water_flowing" },
    { ...light, name: "water_flowing", drawtype: "flowingliquid", paramtype2: "flowingliquid", tiles: ["water.png"], special_tiles: ["flow_top.png", "flow_side.png"], use_texture_alpha: "blend", liquid_alternative_source: "water_source", liquid_alternative_flowing: "water_flowing" },
    { ...light, name: "model", drawtype: "mesh", paramtype2: "facedir", tiles: ["a.png", "b.png"], mesh: "model.obj" }
]

async function setup() {
    const specs: TileSpec[] = []
    const keys = new Map<string, number>()
    const nodes = new NodeRegistry(async name => definitions.find(def => def.name === name) ?? null, {
        getTile(spec) {
            const key = JSON.stringify(spec)
            if (!keys.has(key)) {
                keys.set(key, specs.push(spec) - 1)
            }
            return keys.get(key)!
        }
    })
    await nodes.ensure(definitions.map(def => def.name))
    const neighborhood = createNeighborhood()
    // an empty, fully lit mapblock surrounded by air
    neighborhood.ids.fill(nodes.getId("air"))
    neighborhood.param1.fill(0x0f)

    const set = (x: number, y: number, z: number, name: string, param2 = 0) => {
        neighborhood.ids[paddedIndex(x, y, z)] = nodes.getId(name)
        neighborhood.param2[paddedIndex(x, y, z)] = param2
    }
    const mesh = (nb: Neighborhood = neighborhood) => {
        const result = new Map<string, MeshBuffer>()
        for (const [tile, buffer] of new MapblockMesher(nodes).mesh(nb, { x: 0, y: 0, z: 0 })) {
            result.set(specs[tile]!.texture, buffer)
        }
        return result
    }
    return { nodes, neighborhood, set, mesh, specs }
}

const quads = (buffer: MeshBuffer | undefined) => (buffer?.indices.length ?? 0) / 6
const totalQuads = (buffers: Map<string, MeshBuffer>) => [...buffers.values()].reduce((sum, b) => sum + quads(b), 0)

/** min and max of the vertex positions */
function bounds(buffer: MeshBuffer) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    buffer.positions.forEach((v, i) => {
        min[i % 3] = Math.min(min[i % 3]!, v)
        max[i % 3] = Math.max(max[i % 3]!, v)
    })
    return { min: min.map(v => +v.toFixed(4)), max: max.map(v => +v.toFixed(4)) }
}

/** normals of all triangles by the convention of the engine: (b - a) x (c - a) */
function triangleNormals(buffer: MeshBuffer): string[] {
    const normals: string[] = []
    for (let t = 0; t < buffer.indices.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map(i => buffer.positions.slice(buffer.indices[t + i]! * 3, buffer.indices[t + i]! * 3 + 3)) as [number[], number[], number[]]
        const u = b.map((v, i) => v - a[i]!), v = c.map((w, i) => w - a[i]!)
        const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
        const length = Math.hypot(...n)
        normals.push(n.map(x => Math.round(x / length) + 0).join(","))
    }
    return normals
}

describe("solid nodes", () => {
    it("draws the six faces of a single node, facing outwards", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "stone")
        const stone = mesh().get("stone.png")!
        expect(quads(stone)).toBe(6)
        expect(stone.vertexCount).toBe(24)
        expect(bounds(stone)).toEqual({ min: [2.5, 3.5, 4.5], max: [3.5, 4.5, 5.5] })
        expect(new Set(triangleNormals(stone))).toEqual(new Set(["0,1,0", "0,-1,0", "1,0,0", "-1,0,0", "0,0,1", "0,0,-1"]))
        // every face normal points away from the center of the node
        expect(triangleNormals(stone).slice(0, 2)).toEqual(["0,1,0", "0,1,0"])
    })

    it("skips faces between solid nodes", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "stone")
        set(4, 4, 5, "stone")
        set(3, 5, 5, "grass")
        const buffers = mesh()
        expect(quads(buffers.get("stone.png"))).toBe(9)
        expect(quads(buffers.get("top.png"))).toBe(1)
        expect(quads(buffers.get("side.png"))).toBe(4)
        // the bottom of the grass node is hidden
        expect(buffers.has("bottom.png")).toBe(false)
    })

    it("draws nothing for enclosed nodes and keeps faces at the border of the scene", async () => {
        const { neighborhood, nodes, mesh } = await setup()
        neighborhood.ids.fill(nodes.getId("stone"))
        expect(mesh().size).toBe(0)

        // no mapblocks around: the faces of the outer nodes are visible
        const lonely = createNeighborhood()
        for (let z = 0; z < 16; z++) {
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) {
                    lonely.ids[paddedIndex(x, y, z)] = nodes.getId("stone")
                }
            }
        }
        expect(lonely.ids[paddedIndex(-1, 0, 0)]).toBe(CONTENT_IGNORE)
        expect(quads(mesh(lonely).get("stone.png"))).toBe(6 * 16 * 16)
    })

    it("shades the faces and uses the light of the adjacent node", async () => {
        const { set, mesh, neighborhood } = await setup()
        set(3, 4, 5, "stone")
        neighborhood.param1[paddedIndex(3, 4, 4)] = 0x05 // dark in front of the node
        const stone = mesh().get("stone.png")!
        const brightness = new Map(triangleNormals(stone).map((n, i) => [n, stone.colors[stone.indices[i * 3]! * 3]!]))
        expect(brightness.get("0,1,0")).toBeCloseTo(1)
        expect(brightness.get("0,0,1")!).toBeLessThan(brightness.get("0,1,0")!)
        expect(brightness.get("1,0,0")!).toBeLessThan(brightness.get("0,0,1")!)
        expect(brightness.get("0,-1,0")!).toBeLessThan(brightness.get("1,0,0")!)
        expect(brightness.get("0,0,-1")!).toBeLessThan(brightness.get("0,-1,0")!)
    })

    it("rotates the tiles by facedir", async () => {
        const frontNormal = async (facedir: number) => {
            const { set, mesh } = await setup()
            set(3, 4, 5, "furnace", facedir)
            return triangleNormals(mesh().get("front.png")!)[0]
        }
        expect(await frontNormal(0)).toBe("0,0,-1")
        expect(await frontNormal(1)).toBe("-1,0,0")
        expect(await frontNormal(2)).toBe("0,0,1")
        expect(await frontNormal(3)).toBe("1,0,0")
        expect(await frontNormal(4)).toBe("0,1,0") // top towards z+: lying on its back
    })
})

describe("glass and leaves", () => {
    it("hides faces between glass nodes only", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "glass")
        set(4, 4, 5, "glass")
        set(3, 3, 5, "stone")
        expect(quads(mesh().get("glass.png"))).toBe(10)
    })

    it("draws all faces of leaves", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "leaves")
        set(4, 4, 5, "leaves")
        expect(quads(mesh().get("leaves.png"))).toBe(12)
    })

    it("merges the frames of connected framed glass", async () => {
        const single = await setup()
        single.set(3, 4, 5, "framed")
        let buffers = single.mesh()
        // 12 frame edges with 6 faces each, 6 glass panes
        expect(quads(buffers.get("frame.png"))).toBe(72)
        expect(quads(buffers.get("detail.png"))).toBe(6)

        const pair = await setup()
        pair.set(3, 4, 5, "framed")
        pair.set(4, 4, 5, "framed")
        buffers = pair.mesh()
        // the 4 edges around the shared face are dropped on both nodes
        expect(quads(buffers.get("frame.png"))).toBe(2 * 8 * 6)
        expect(quads(buffers.get("detail.png"))).toBe(10)
    })
})

describe("plants, torches, signs, fire", () => {
    it("draws plants as crossed quads scaled by visual_scale", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "plant")
        const plant = mesh().get("plant.png")!
        expect(quads(plant)).toBe(2)
        const { min, max } = bounds(plant)
        expect(min[1]).toBe(3.5)
        expect(max[1]).toBe(5.5)
        // not shaded
        expect(plant.colors.every(c => Math.abs(c - 1) < 1e-6)).toBe(true)
    })

    it("supports the plant styles of meshoptions", async () => {
        const count = async (param2: number) => {
            const { set, mesh } = await setup()
            set(3, 4, 5, "wheat", param2)
            return quads(mesh().get("wheat.png"))
        }
        expect(await Promise.all([0, 1, 2, 3, 4].map(count))).toEqual([2, 2, 3, 4, 4])
    })

    it("draws the plant of rooted nodes above the node with its leveled height", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "kelp", 48)
        const buffers = mesh()
        expect(quads(buffers.get("sand.png"))).toBe(6)
        const kelp = buffers.get("kelp.png")!
        expect(quads(kelp)).toBe(2)
        expect(bounds(kelp).min[1]).toBe(4.5)
        expect(bounds(kelp).max[1]).toBe(7.5)
        // the texture is repeated along the height
        expect(Math.max(...kelp.uvs)).toBe(3)
    })

    it("selects the torch tile by the wall direction", async () => {
        const tile = async (param2: number) => {
            const { set, mesh } = await setup()
            set(3, 4, 5, "torch", param2)
            return [...mesh().keys()]
        }
        expect(await tile(0)).toEqual(["ceiling.png"])
        expect(await tile(1)).toEqual(["floor.png"])
        expect(await tile(2)).toEqual(["wall.png"])
        expect(await tile(5)).toEqual(["wall.png"])
    })

    it("places signs flat on the wall", async () => {
        const plane = async (param2: number) => {
            const { set, mesh } = await setup()
            set(3, 4, 5, "sign", param2)
            return bounds(mesh().get("sign.png")!)
        }
        expect((await plane(2)).min[0]).toBe(3.4375) // x+
        expect((await plane(2)).max[0]).toBe(3.4375)
        expect((await plane(3)).max[0]).toBe(2.5625) // x-
        expect((await plane(0)).min[1]).toBe(4.4375) // ceiling
        expect((await plane(1)).max[1]).toBe(3.5625) // floor
        expect((await plane(4)).min[2]).toBe(5.4375) // z+
        expect((await plane(5)).max[2]).toBe(4.5625) // z-
    })

    it("draws fire depending on the surrounding nodes", async () => {
        const free = await setup()
        free.set(3, 4, 5, "fire")
        expect(quads(free.mesh().get("fire.png"))).toBe(6)

        const wall = await setup()
        wall.set(3, 4, 5, "fire")
        wall.set(4, 4, 5, "stone")
        expect(quads(wall.mesh().get("fire.png"))).toBe(1)
    })
})

describe("rails and fences", () => {
    const railTiles = async (rails: [number, number, number][]) => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "rail")
        rails.forEach(([x, y, z]) => set(x, y, z, "rail"))
        // tile of the quad that covers the node at 3,4,5
        for (const [texture, buffer] of mesh()) {
            for (let quad = 0; quad < buffer.vertexCount; quad += 4) {
                const center = [0, 1, 2].map(axis => [0, 1, 2, 3].reduce((sum, i) => sum + buffer.positions[(quad + i) * 3 + axis]! / 4, 0))
                if (Math.abs(center[0]! - 3) < 1e-6 && Math.abs(center[2]! - 5) < 1e-6) {
                    return texture
                }
            }
        }
        return null
    }

    it("selects the rail tile by the connected neighbors", async () => {
        expect(await railTiles([])).toBe("straight.png")
        expect(await railTiles([[3, 4, 6]])).toBe("straight.png")
        expect(await railTiles([[3, 4, 6], [4, 4, 5]])).toBe("curved.png")
        expect(await railTiles([[3, 4, 6], [4, 4, 5], [2, 4, 5]])).toBe("junction.png")
        expect(await railTiles([[3, 4, 6], [3, 4, 4], [4, 4, 5], [2, 4, 5]])).toBe("cross.png")
    })

    it("raises rails towards a rail one node above", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "rail")
        set(4, 5, 5, "rail")
        const buffer = mesh().get("straight.png")!
        // the first quad is the lower rail: sloped up towards x+
        const quad = buffer.positions.slice(0, 12)
        const high = [0, 1, 2, 3].filter(i => quad[i * 3 + 1]! > 4)
        expect(high).toHaveLength(2)
        high.forEach(i => expect(quad[i * 3]).toBe(3.5))
    })

    it("connects legacy fences towards +x and +z", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "oldfence")
        expect(quads(mesh().get("wood.png"))).toBe(6)
        set(4, 4, 5, "oldfence")
        set(3, 4, 6, "oldfence")
        // 3 posts and 2 bars for each of the two connections
        expect(quads(mesh().get("wood.png"))).toBe((3 + 4) * 6)
    })
})

describe("nodeboxes", () => {
    it("draws fixed boxes with texture coordinates aligned to the node", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "slab")
        const slab = mesh().get("wood.png")!
        expect(quads(slab)).toBe(6)
        expect(bounds(slab)).toEqual({ min: [2.5, 3.5, 4.5], max: [3.5, 4, 5.5] })
        // the side faces only use the lower half of the texture
        expect(slab.uvs.filter((_, i) => i % 2 === 1).some(v => v === 0.5)).toBe(true)
    })

    it("hides faces at the node boundary that touch solid nodes", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "slab")
        set(3, 3, 5, "stone")
        set(4, 4, 5, "stone")
        expect(quads(mesh().get("wood.png"))).toBe(4)
    })

    it("rotates the boxes by facedir", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "slab", 20) // upside down
        expect(bounds(mesh().get("wood.png")!)).toEqual({ min: [2.5, 4, 4.5], max: [3.5, 4.5, 5.5] })
        set(3, 4, 5, "slab", 12) // bottom towards x-
        expect(bounds(mesh().get("wood.png")!)).toEqual({ min: [2.5, 3.5, 4.5], max: [3, 4.5, 5.5] })
    })

    it("adds the boxes of connected neighbors", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "fence")
        expect(quads(mesh().get("wood.png"))).toBe(6)
        set(4, 4, 5, "fence") // group
        set(3, 4, 4, "stone") // name
        set(3, 4, 6, "glass") // not connected
        const fence = mesh().get("wood.png")!
        // 2 posts, the first has 2 connections, the second 1: 5 boxes, the face that touches the stone is hidden
        expect(quads(fence)).toBe((2 + 3) * 6 - 1)
        expect(bounds(fence).min[2]).toBe(4.5)
        expect(bounds(fence).max[2]).toBe(5.125)
    })

    it("selects the box of wallmounted nodeboxes by the wall direction", async () => {
        const box = async (param2: number) => {
            const { set, mesh } = await setup()
            set(0, 0, 0, "wallsign", param2)
            return bounds(mesh().get("sign.png")!)
        }
        expect(await box(0)).toEqual({ min: [-0.4, 0.4, -0.3], max: [0.4, 0.5, 0.3] })
        expect(await box(1)).toEqual({ min: [-0.4, -0.5, -0.3], max: [0.4, -0.4, 0.3] })
        expect(await box(3)).toEqual({ min: [-0.5, -0.3, -0.4], max: [-0.4, 0.3, 0.4] })
        expect(await box(2)).toEqual({ min: [0.4, -0.3, -0.4], max: [0.5, 0.3, 0.4] })
        expect(await box(4)).toEqual({ min: [-0.4, -0.3, 0.4], max: [0.4, 0.3, 0.5] })
        expect(await box(5)).toEqual({ min: [-0.4, -0.3, -0.5], max: [0.4, 0.3, -0.4] })
    })
})

describe("liquids", () => {
    it("draws liquid sources as cubes without faces between them", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "water_source")
        set(4, 4, 5, "water_source")
        set(3, 3, 5, "stone")
        set(3, 4, 6, "water_flowing", 7)
        // 12 faces - 2 between the sources - 1 towards the stone - 1 towards the flowing liquid
        expect(quads(mesh().get("water.png"))).toBe(8)
    })

    it("lowers the surface of flowing liquids", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "water_flowing", 7)
        const buffers = mesh()
        const top = buffers.get("flow_top.png")!
        const side = buffers.get("flow_side.png")!
        // top and bottom, 4 sides
        expect(quads(top)).toBe(2)
        expect(quads(side)).toBe(4)
        // surrounded by air: the surface is almost at the bottom
        expect(bounds(side).max[1]).toBeCloseTo(4 - 0.5 + 0.02)
    })

    it("connects flowing liquids to adjacent sources", async () => {
        const { set, mesh } = await setup()
        for (let x = 2; x <= 4; x++) {
            for (let z = 4; z <= 6; z++) {
                set(x, 3, z, "stone")
                set(x, 4, z, "water_flowing", 7)
            }
        }
        set(2, 4, 5, "water_source")
        const top = mesh().get("flow_top.png")!
        // surface of the center node: full height next to the source, lower on the other side
        const heights = new Map<number, number>()
        for (let i = 0; i < top.positions.length; i += 3) {
            if (top.positions[i + 2]! >= 4.5 && top.positions[i + 2]! <= 5.5 && [2.5, 3.5].includes(top.positions[i]!)) {
                heights.set(top.positions[i]!, Math.max(heights.get(top.positions[i]!) ?? -Infinity, top.positions[i + 1]!))
            }
        }
        expect(heights.get(2.5)).toBe(4.5)
        expect(heights.get(3.5)).toBeCloseTo(4 - 0.5 + 7.5 / 8)
        // no bottom faces on top of the stone
        expect(quads(top)).toBe(8)
    })
})

describe("meshes", () => {
    const triangle = {
        buffers: [{
            positions: new Float32Array([0, 0.5, -0.5, 0.5, 0.5, -0.5, 0, -0.5, -0.5]),
            normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
            indices: new Uint32Array([0, 1, 2])
        }, {
            positions: new Float32Array([0, 0.5, 0, 0.5, 0.5, 0, 0, 0.5, 0.5]),
            normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
            indices: new Uint32Array([0, 1, 2])
        }]
    }

    it("skips nodes without a loaded model", async () => {
        const { set, mesh } = await setup()
        set(3, 4, 5, "model")
        expect(mesh().size).toBe(0)
    })

    it("assigns one tile per buffer and rotates the model by facedir", async () => {
        const { set, mesh, nodes } = await setup()
        set(3, 4, 5, "model")
        nodes.infos[nodes.getId("model")]!.model = triangle
        let buffers = mesh()
        expect(buffers.get("a.png")!.indices).toEqual([0, 1, 2])
        expect(bounds(buffers.get("a.png")!)).toEqual({ min: [3, 3.5, 4.5], max: [3.5, 4.5, 4.5] })
        expect(bounds(buffers.get("b.png")!).min[1]).toBe(4.5)

        set(3, 4, 5, "model", 1)
        buffers = mesh()
        // the front moved to x-
        expect(bounds(buffers.get("a.png")!)).toEqual({ min: [2.5, 3.5, 4.5], max: [2.5, 4.5, 5] })
        // shaded by the rotated normal: darker than the top
        expect(buffers.get("a.png")!.colors[0]!).toBeLessThan(buffers.get("b.png")!.colors[0]!)
    })
})
