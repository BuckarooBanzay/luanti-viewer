import { MAPBLOCK_SIZE, MAPBLOCK_VOLUME, ParsedMapblock, getNodeIndex, type MapblockPosition, type NodeDefinition } from "../src"

/**
 * A generated scene that contains at least one example for every drawtype.
 * Most nodes come from the exported node definitions (minetest_game + moreblocks),
 * the drawtypes that are not used there are covered by the "demo:*" nodes below.
 */

const demoNodes: NodeDefinition[] = [
    {
        name: "demo:torchlike",
        drawtype: "torchlike",
        paramtype: "light",
        paramtype2: "wallmounted",
        light_source: 12,
        groups: null,
        // floor, ceiling, wall
        tiles: ["default_torch_on_floor.png", "default_torch_on_floor.png^[transformFY", "default_torch_on_floor.png^[transformR90"]
    },
    {
        name: "demo:fencelike",
        drawtype: "fencelike",
        paramtype: "light",
        paramtype2: "none",
        light_source: 0,
        groups: null,
        tiles: ["default_wood.png"]
    },
    {
        name: "demo:allfaces",
        drawtype: "allfaces",
        paramtype: "light",
        paramtype2: "none",
        light_source: 0,
        groups: null,
        tiles: ["default_jungleleaves.png"]
    },
    {
        name: "demo:glasslike",
        drawtype: "glasslike",
        paramtype: "light",
        paramtype2: "none",
        light_source: 0,
        groups: null,
        tiles: ["default_obsidian_glass.png"]
    },
    {
        name: "demo:framed_glass",
        drawtype: "glasslike_framed",
        paramtype: "light",
        paramtype2: "none",
        light_source: 0,
        groups: null,
        tiles: ["default_glass.png", "default_glass_detail.png"]
    },
    {
        name: "demo:tank",
        drawtype: "glasslike_framed",
        paramtype: "light",
        paramtype2: "glasslikeliquidlevel",
        light_source: 0,
        groups: null,
        tiles: ["default_glass.png", "default_glass_detail.png"],
        special_tiles: ["default_water.png"]
    },
    {
        name: "demo:colored",
        drawtype: "normal",
        paramtype: "none",
        paramtype2: "none",
        light_source: 0,
        groups: null,
        color: "#6fbf4a",
        tiles: ["default_snow.png^[colorize:#000:40^(default_mineral_coal.png^[transformR90)"]
    },
    {
        name: "demo:leveled",
        drawtype: "nodebox",
        paramtype: "light",
        paramtype2: "leveled",
        light_source: 0,
        groups: null,
        tiles: ["default_snow.png"],
        node_box: { type: "leveled", fixed: [-0.5, -0.5, -0.5, 0.5, -0.25, 0.5] }
    }
]

const SIZE_X = 3
const SIZE_Z = 3

class SceneBuilder {
    private readonly blocks = new Map<string, { ids: Uint16Array, param1: Uint8Array, param2: Uint8Array }>()
    private readonly names: string[] = ["air"]

    private id(name: string): number {
        let id = this.names.indexOf(name)
        if (id < 0) {
            id = this.names.push(name) - 1
        }
        return id
    }

    set(x: number, y: number, z: number, name: string, param2 = 0): void {
        const bx = Math.floor(x / MAPBLOCK_SIZE), by = Math.floor(y / MAPBLOCK_SIZE), bz = Math.floor(z / MAPBLOCK_SIZE)
        const key = `${bx},${by},${bz}`
        let block = this.blocks.get(key)
        if (!block) {
            block = {
                ids: new Uint16Array(MAPBLOCK_VOLUME),
                // full daylight everywhere
                param1: new Uint8Array(MAPBLOCK_VOLUME).fill(0x0f),
                param2: new Uint8Array(MAPBLOCK_VOLUME)
            }
            this.blocks.set(key, block)
        }
        const index = getNodeIndex(x - bx * MAPBLOCK_SIZE, y - by * MAPBLOCK_SIZE, z - bz * MAPBLOCK_SIZE)
        block.ids[index] = this.id(name)
        block.param2[index] = param2
    }

    fill(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, name: string, param2 = 0): void {
        for (let x = x1; x <= x2; x++) {
            for (let y = y1; y <= y2; y++) {
                for (let z = z1; z <= z2; z++) {
                    this.set(x, y, z, name, param2)
                }
            }
        }
    }

    getMapblock(pos: MapblockPosition): ParsedMapblock | null {
        const block = this.blocks.get(`${pos.x},${pos.y},${pos.z}`)
        if (!block) {
            return null
        }
        return new ParsedMapblock(block.ids, block.param1, block.param2, new Map(this.names.map((name, id) => [id, name])))
    }
}

// wallmounted param2: the direction of the wall the node is attached to
const WALL_YP = 0, WALL_YN = 1, WALL_XP = 2, WALL_XN = 3, WALL_ZP = 4, WALL_ZN = 5

export function createShowcase() {
    const b = new SceneBuilder()
    const G = 1 // first level above the ground

    // ground
    b.fill(0, 0, 0, SIZE_X * MAPBLOCK_SIZE - 1, 0, SIZE_Z * MAPBLOCK_SIZE - 1, "default:dirt_with_grass")

    // ---- z = 2: normal ----
    let z = 2
    b.set(2, G, z, "default:stone")
    b.set(4, G, z, "default:dirt_with_grass")
    b.set(6, G, z, "demo:colored")
    b.set(8, G, z, "missing:node")
    for (let facedir = 0; facedir < 4; facedir++) {
        b.set(10 + facedir * 2, G, z, "default:furnace", facedir)
        b.set(19 + facedir * 2, G, z, "default:chest", facedir)
    }
    b.set(28, G, z, "default:furnace_active")
    // all 24 facedirs
    for (let facedir = 0; facedir < 24; facedir++) {
        b.set(2 + (facedir % 12) * 2, G + 3 + Math.floor(facedir / 12) * 2, z, "default:bookshelf", facedir)
    }
    b.fill(30, G, z, 30, G + 3, z, "default:tree")
    b.set(32, G, z, "default:tree", 12)
    b.set(34, G, z, "default:tree", 4)
    b.fill(36, G, z, 36, G + 2, z, "default:cactus")

    // ---- z = 6: glass ----
    z = 6
    b.fill(2, G, z, 4, G + 1, z, "default:glass")
    b.set(6, G, z, "demo:glasslike")
    b.set(8, G, z, "default:meselamp")
    b.fill(10, G, z, 12, G + 2, z, "demo:framed_glass")
    b.set(12, G + 2, z, "air")
    b.set(14, G, z, "demo:framed_glass")
    b.set(16, G, z, "moreblocks:trap_stone")
    b.fill(18, G, z, 19, G + 1, z, "demo:tank", 40)
    b.set(21, G, z, "demo:tank", 20)
    // leaves
    b.fill(24, G, z, 24, G + 2, z, "default:tree")
    b.fill(23, G + 3, z - 1, 25, G + 4, z + 1, "default:leaves")
    b.set(24, G + 5, z, "default:leaves")
    b.fill(28, G, z, 29, G + 1, z, "demo:allfaces")
    b.set(31, G, z, "default:bush_leaves")

    // ---- z = 10 .. 13: liquids ----
    z = 10
    const basin = (x1: number, x2: number, source: string, flowing: string) => {
        b.fill(x1 - 1, G, z - 1, x2 + 1, G + 1, z + 3, "default:stone")
        b.fill(x1, G + 1, z, x2, G + 1, z + 2, "air")
        b.fill(x1, G + 1, z, x1 + 1, G + 1, z + 2, source)
        // flowing liquid with decreasing levels
        for (let x = x1 + 2, level = 7; x <= x2; x++, level--) {
            b.fill(x, G + 1, z, x, G + 1, z + 2, flowing, Math.max(level, 1))
        }
        // waterfall at the end
        b.set(x2 + 1, G + 1, z + 1, flowing, 1)
        b.set(x2 + 2, G + 1, z + 1, flowing, 8 + 7)
        b.set(x2 + 2, G, z + 1, flowing, 7)
        b.set(x2 + 3, G, z + 1, flowing, 5)
        b.set(x2 + 2, G, z, flowing, 5)
        b.set(x2 + 2, G, z + 2, flowing, 5)
    }
    basin(2, 10, "default:water_source", "default:water_flowing")
    basin(18, 26, "default:lava_source", "default:lava_flowing")
    b.fill(32, G, z, 34, G, z + 2, "default:river_water_source")
    // rooted plants
    b.fill(37, G, z - 1, 43, G + 3, z + 3, "default:water_source")
    b.fill(37, G, z - 1, 43, G, z + 3, "default:sand")
    b.set(38, G, z, "default:sand_with_kelp", 48)
    b.set(40, G, z + 1, "default:sand_with_kelp", 32)
    b.set(42, G, z, "default:sand_with_kelp", 24)
    b.set(38, G, z + 2, "default:coral_green")
    b.set(40, G, z + 2, "default:coral_pink")
    b.set(42, G, z + 2, "default:coral_cyan")

    // ---- z = 17: plants ----
    z = 17
    const plants = [
        "default:grass_1", "default:grass_3", "default:grass_5", "default:junglegrass", "default:dry_grass_3",
        "default:fern_2", "default:marram_grass_2", "flowers:rose", "flowers:tulip", "flowers:dandelion_yellow",
        "flowers:mushroom_red", "default:sapling", "default:acacia_bush_stem", "vessels:glass_bottle",
        "butterflies:butterfly_red"
    ]
    plants.forEach((name, i) => b.set(2 + i * 2, G, z, name))
    b.fill(33, G, z, 33, G + 2, z, "default:papyrus")
    // meshoptions: styles 0..4, then with the scale, random offset and random y offset bits
    for (let style = 0; style < 5; style++) {
        b.set(2 + style * 2, G, z + 2, "farming:wheat_8", style)
        b.set(13 + style * 2, G, z + 2, "farming:wheat_8", style | 0x10)
        b.set(24 + style * 2, G, z + 2, "farming:wheat_8", style | 0x08 | 0x20)
    }
    b.set(36, G, z + 2, "default:dry_shrub", 4)

    // ---- z = 22: torches, signs, fire ----
    z = 22
    b.fill(4, G, z, 4, G + 2, z, "default:stone")
    b.set(4, G + 3, z, "demo:torchlike", WALL_YN)
    b.set(5, G + 1, z, "demo:torchlike", WALL_XN)
    b.set(3, G + 1, z, "demo:torchlike", WALL_XP)
    b.set(4, G + 1, z + 1, "demo:torchlike", WALL_ZN)
    b.set(4, G + 1, z - 1, "demo:torchlike", WALL_ZP)
    b.set(2, G, z, "demo:torchlike", WALL_YN)
    b.fill(6, G + 3, z, 7, G + 3, z, "default:stone")
    b.set(6, G + 2, z, "demo:torchlike", WALL_YP)

    b.fill(11, G, z, 11, G + 3, z, "default:stone")
    b.set(9, G, z, "default:torch", WALL_YN)
    b.set(12, G + 1, z, "default:torch_wall", WALL_XN)
    b.set(10, G + 1, z, "default:torch_wall", WALL_XP)
    b.set(11, G + 1, z + 1, "default:torch_wall", WALL_ZN)
    b.set(11, G + 1, z - 1, "default:torch_wall", WALL_ZP)
    b.fill(12, G + 3, z, 13, G + 3, z, "default:stone")
    b.set(13, G + 2, z, "default:torch_ceiling", WALL_YP)

    b.fill(17, G, z, 17, G + 3, z, "default:stone")
    b.fill(18, G, z, 18, G + 3, z, "default:ladder_wood", WALL_XN)
    b.fill(16, G, z, 16, G + 3, z, "default:ladder_steel", WALL_XP)
    b.fill(17, G, z + 1, 17, G + 3, z + 1, "moreblocks:rope", WALL_ZN)
    b.set(17, G + 1, z - 1, "default:sign_wall_wood", WALL_ZP)
    b.set(17, G + 4, z, "default:sign_wall_steel", WALL_YN)
    b.set(15, G, z, "default:ladder_wood", WALL_YN)
    b.fill(19, G + 3, z, 20, G + 3, z, "default:stone")
    b.set(20, G + 2, z, "default:sign_wall_wood", WALL_YP)

    b.set(24, G, z, "fire:basic_flame")
    b.set(27, G, z, "default:coalblock")
    b.set(27, G + 1, z, "fire:permanent_flame")
    // fire attached to walls and the ceiling
    b.fill(31, G + 1, z, 31, G + 3, z, "default:stone")
    b.set(30, G + 2, z, "fire:basic_flame")
    b.set(32, G + 2, z, "fire:basic_flame")
    b.set(31, G + 2, z - 1, "fire:basic_flame")
    b.fill(34, G + 2, z, 35, G + 2, z, "default:stone")
    b.set(35, G + 1, z, "fire:basic_flame")

    // ---- z = 27: rails ----
    z = 27
    b.fill(2, G, z, 6, G, z, "carts:rail")
    b.fill(4, G, z - 2, 4, G, z + 2, "carts:rail") // crossing
    b.fill(6, G, z + 1, 6, G, z + 2, "carts:rail") // curve
    b.fill(8, G, z + 2, 10, G, z + 2, "carts:powerrail")
    b.set(7, G, z + 2, "carts:rail")
    b.set(9, G, z + 1, "carts:brakerail") // junction
    // slope
    for (let i = 0; i < 3; i++) {
        b.fill(11 + i, G, z + 2, 13, G + i, z + 2, "default:stone")
        b.set(11 + i, G + 1 + i, z + 2, "carts:rail")
    }
    b.set(13, G, z + 2, "default:stone")
    b.set(14, G + 3, z + 2, "default:stone")
    b.set(14, G + 4, z + 2, "carts:rail")
    b.set(16, G, z, "carts:rail")
    b.fill(18, G, z, 20, G, z, "tnt:gunpowder")
    b.fill(20, G, z + 1, 20, G, z + 2, "tnt:gunpowder")

    // ---- z = 27: fences ----
    b.fill(23, G, z, 27, G, z, "demo:fencelike")
    b.fill(23, G, z + 1, 23, G, z + 3, "demo:fencelike")
    b.fill(30, G, z, 34, G, z, "default:fence_wood")
    b.fill(30, G, z + 1, 30, G, z + 3, "default:fence_wood")
    b.set(35, G, z, "default:wood")
    b.fill(32, G, z + 3, 34, G, z + 3, "default:fence_rail_wood")
    b.set(37, G, z + 3, "default:fence_wood")
    b.fill(38, G, z, 42, G, z, "walls:cobble")
    b.fill(40, G, z + 1, 40, G, z + 3, "walls:cobble")
    b.set(44, G, z + 2, "walls:cobble")

    // ---- z = 33: nodeboxes ----
    z = 33
    for (let facedir = 0; facedir < 4; facedir++) {
        b.set(2 + facedir * 2, G, z, "moreblocks:stair_wood", facedir)
        b.set(2 + facedir * 2, G, z + 2, "moreblocks:stair_wood_inner", facedir)
        b.set(2 + facedir * 2, G, z + 4, "moreblocks:stair_wood_outer", facedir)
        // upside down
        b.set(2 + facedir * 2, G + 2, z, "moreblocks:stair_wood", 20 + facedir)
    }
    b.set(11, G, z, "moreblocks:slab_wood")
    b.set(11, G, z + 2, "moreblocks:slab_wood", 20)
    b.set(11, G, z + 4, "moreblocks:slab_wood", 4)
    b.set(13, G, z, "beds:bed_bottom")
    b.set(13, G, z + 1, "beds:bed_top")
    b.set(15, G, z, "beds:fancy_bed_bottom")
    b.set(15, G, z + 1, "beds:fancy_bed_top")
    b.fill(17, G, z, 19, G, z, "xpanes:pane_flat")
    b.fill(17, G, z + 2, 19, G, z + 2, "xpanes:bar_flat")
    b.set(21, G, z, "default:mese_post_light")
    b.fill(23, G, z, 25, G, z + 1, "default:snow")
    b.set(27, G, z, "doors:trapdoor")
    b.set(27, G, z + 2, "doors:trapdoor", 20)
    for (let i = 0; i < 6; i++) {
        b.set(30 + i, G, z, "demo:leveled", 8 + i * 12)
    }
    b.fill(30, G, z + 2, 32, G, z + 4, "default:water_source")
    b.set(31, G + 1, z + 3, "flowers:waterlily")

    // ---- z = 40: meshes ----
    z = 40
    for (let facedir = 0; facedir < 4; facedir++) {
        b.set(2 + facedir * 2, G, z, "moreblocks:slope_stone", facedir)
        b.set(2 + facedir * 2, G, z + 2, "moreblocks:slope_stone_inner", facedir)
        b.set(2 + facedir * 2, G, z + 4, "moreblocks:slope_stone_outer", facedir)
        b.set(2 + facedir * 2, G + 2, z, "moreblocks:slope_stone", 20 + facedir)
        b.set(12 + facedir * 2, G, z, "doors:door_wood_a", facedir)
        b.set(12 + facedir * 2, G, z + 3, "doors:door_glass_a", facedir)
        b.set(21 + facedir * 2, G, z, "default:chest_open", facedir)
        b.set(30 + facedir * 2, G, z, "doors:gate_wood_closed", facedir)
        b.set(30 + facedir * 2, G, z + 2, "doors:gate_wood_open", facedir)
    }
    b.set(21, G, z + 3, "doors:door_steel_b")
    b.set(23, G, z + 3, "doors:door_obsidian_glass_a")
    b.set(11, G, z + 4, "moreblocks:slope_wood_half")
    b.set(11, G, z + 2, "moreblocks:slope_wood_half_raised")

    return {
        nodeDefinitions: new Map(demoNodes.map(def => [def.name, def] as const)),
        getMapblock: (pos: MapblockPosition) => b.getMapblock(pos),
        minPos: { x: 0, y: 0, z: 0 },
        maxPos: { x: SIZE_X - 1, y: 0, z: SIZE_Z - 1 }
    }
}
