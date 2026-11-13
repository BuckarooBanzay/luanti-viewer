import type { AlphaMode, Box, BoxList, Color, DrawType, NodeDefinition, ParamType2, Tile, TileAnimation } from "../types"
import type { Model } from "../models/model"

/** everything needed to create a material for a node face */
export type TileSpec = {
    /** texture name including texture modifiers */
    texture: string
    animation?: TileAnimation
    backfaceCulling: boolean
    alpha: AlphaMode
}

/** hands out a numeric id per distinct tile, the mesher groups the geometry by this id */
export interface TileRegistry {
    getTile(spec: TileSpec): number
}

/** content id of positions without a loaded mapblock */
export const CONTENT_IGNORE = 0

/** drawtypes after resolving the "_optional" variants */
export type ResolvedDrawType = Exclude<DrawType, "allfaces_optional" | "glasslike_framed_optional">

export type CompiledNodeBox = {
    type: "regular" | "fixed" | "leveled" | "connected" | "wallmounted"
    fixed: Box[]
    /** indexed by the connection direction: top, bottom, front, left, back, right */
    connect: Box[][]
    disconnected: Box[][]
    disconnectedAll: Box[]
    disconnectedSides: Box[]
    wallTop: Box | null
    wallBottom: Box | null
    wallSide: Box | null
}

/** a node definition prepared for meshing */
export type NodeInfo = {
    id: number
    name: string
    def: NodeDefinition
    drawtype: ResolvedDrawType
    /** occludes the faces of its neighbors (solidness 2 in the engine) */
    solid: boolean
    isAir: boolean
    /** tile ids for top, bottom, right, left, back, front */
    tiles: number[]
    /** tile ids of the special tiles, -1 if not defined */
    specialTiles: number[]
    alpha: AlphaMode
    /** paramtype = "light": param1 contains the light of the node itself */
    lightPropagates: boolean
    lightSource: number
    visualScale: number
    /** linear rgb multiplier */
    color: [number, number, number]
    param2Type: ParamType2
    /** param2 contains a rotation (facedir, 4dir or wallmounted) */
    param2IsRotation: boolean
    nodeBox: CompiledNodeBox | null
    raillikeGroup: number
    liquidRange: number
    /** set by the viewer once the model is loaded */
    model: Model | null
}

const DEFAULT_OPAQUE: ReadonlySet<string> = new Set(["normal", "liquid", "flowingliquid", "nodebox", "mesh"])
const ROTATION_PARAM2: ReadonlySet<string> = new Set([
    "facedir", "colorfacedir", "4dir", "color4dir", "wallmounted", "colorwallmounted"
])

function isBox(v: unknown): v is Box {
    return Array.isArray(v) && v.length >= 6 && typeof v[0] === "number"
}

/** normalizes a single box or a list of boxes, min/max are sorted */
export function toBoxes(list: BoxList | null | undefined): Box[] {
    if (!Array.isArray(list)) {
        return []
    }
    const boxes = isBox(list) ? [list] : (list as unknown[]).filter(isBox)
    return boxes.map(repairBox)
}

export function repairBox(b: ArrayLike<number>): Box {
    return [
        Math.min(b[0]!, b[3]!), Math.min(b[1]!, b[4]!), Math.min(b[2]!, b[5]!),
        Math.max(b[0]!, b[3]!), Math.max(b[1]!, b[4]!), Math.max(b[2]!, b[5]!)
    ]
}

function compileNodeBox(def: NodeDefinition): CompiledNodeBox {
    const nb = def.node_box
    const result: CompiledNodeBox = {
        type: "regular",
        fixed: [],
        connect: [[], [], [], [], [], []],
        disconnected: [[], [], [], [], [], []],
        disconnectedAll: [],
        disconnectedSides: [],
        wallTop: null,
        wallBottom: null,
        wallSide: null
    }
    if (!nb) {
        return result
    }
    result.type = nb.type
    if (nb.type === "fixed" || nb.type === "leveled") {
        result.fixed = toBoxes(nb.fixed)
    } else if (nb.type === "connected") {
        result.fixed = toBoxes(nb.fixed)
        result.connect = [
            nb.connect_top, nb.connect_bottom, nb.connect_front, nb.connect_left, nb.connect_back, nb.connect_right
        ].map(toBoxes)
        result.disconnected = [
            nb.disconnected_top, nb.disconnected_bottom, nb.disconnected_front,
            nb.disconnected_left, nb.disconnected_back, nb.disconnected_right
        ].map(toBoxes)
        result.disconnectedAll = toBoxes(nb.disconnected)
        result.disconnectedSides = toBoxes(nb.disconnected_sides)
    } else if (nb.type === "wallmounted") {
        result.wallTop = toBoxes(nb.wall_top)[0] ?? null
        result.wallBottom = toBoxes(nb.wall_bottom)[0] ?? null
        result.wallSide = toBoxes(nb.wall_side)[0] ?? null
    }
    return result
}

function resolveDrawType(drawtype: DrawType): ResolvedDrawType {
    switch (drawtype) {
        // engine defaults: leaves_style = fancy, connected_glass = false
        case "allfaces_optional": return "allfaces"
        case "glasslike_framed_optional": return "glasslike"
        default: return drawtype
    }
}

function resolveAlpha(def: NodeDefinition): AlphaMode {
    const alpha = def.use_texture_alpha
    if (alpha === "opaque" || alpha === "clip" || alpha === "blend") {
        return alpha
    }
    if (alpha === true) {
        return "blend"
    }
    return DEFAULT_OPAQUE.has(def.drawtype) ? "opaque" : "clip"
}

const srgbToLinear = (v: number) => Math.pow(Math.min(Math.max(v, 0), 1), 2.2)

/** parses "#RGB", "#RGBA", "#RRGGBB", "#RRGGBBAA" or a color table into a linear rgb multiplier */
export function parseNodeColor(color: string | Color | null | undefined): [number, number, number] {
    if (color && typeof color === "object") {
        return [srgbToLinear(color.r / 255), srgbToLinear(color.g / 255), srgbToLinear(color.b / 255)]
    }
    if (typeof color === "string" && color.startsWith("#")) {
        let hex = color.slice(1)
        if (hex.length === 3 || hex.length === 4) {
            hex = [...hex].map(c => c + c).join("")
        }
        if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
            return [0, 2, 4].map(o => srgbToLinear(parseInt(hex.slice(o, o + 2), 16) / 255)) as [number, number, number]
        }
    }
    return [1, 1, 1]
}

/** interns node names into dense ids and compiles their definitions on first use */
export class NodeRegistry {
    /** indexed by the internal content id, index 0 is CONTENT_IGNORE */
    readonly infos: NodeInfo[] = []
    private readonly ids = new Map<string, number>()
    readonly airId: number

    constructor(private readonly defs: ReadonlyMap<string, NodeDefinition>, private readonly tiles: TileRegistry) {
        this.infos.push(this.compile(CONTENT_IGNORE, {
            name: "ignore", drawtype: "airlike", paramtype: "none", paramtype2: "none", light_source: 0, groups: null
        }))
        this.airId = this.getId("air")
    }

    /** internal id of a node, unknown nodes are rendered as a placeholder cube */
    getId(name: string): number {
        let id = this.ids.get(name)
        if (id === undefined) {
            id = this.infos.length
            this.ids.set(name, id)
            const def = this.defs.get(name) ?? (name === "air" ? {
                name, drawtype: "airlike", paramtype: "light", paramtype2: "none", light_source: 0, groups: null
            } : {
                name, drawtype: "normal", paramtype: "none", paramtype2: "none", light_source: 0, groups: null,
                tiles: ["unknown_node.png"]
            })
            this.infos.push(this.compile(id, def))
        }
        return id
    }

    /** id of a node name, CONTENT_IGNORE for empty names */
    lookup(name: string | null | undefined): number {
        return name ? this.getId(name) : -1
    }

    private compile(id: number, def: NodeDefinition): NodeInfo {
        const drawtype = resolveDrawType(def.drawtype)
        const alpha = resolveAlpha(def)

        return {
            id,
            name: def.name,
            def,
            drawtype,
            solid: drawtype === "normal",
            isAir: def.name === "air",
            tiles: drawtype === "airlike" ? [-1, -1, -1, -1, -1, -1] : this.compileTiles(def, drawtype, alpha),
            specialTiles: this.compileSpecialTiles(def, drawtype, alpha),
            alpha,
            lightPropagates: def.paramtype === "light",
            lightSource: Math.min(Math.max(def.light_source ?? 0, 0), 14),
            visualScale: def.visual_scale ?? 1,
            color: parseNodeColor(def.color),
            param2Type: def.paramtype2 ?? "none",
            param2IsRotation: ROTATION_PARAM2.has(def.paramtype2),
            nodeBox: drawtype === "nodebox" ? compileNodeBox(def) : null,
            raillikeGroup: def.groups?.["connect_to_raillike"] ?? 0,
            liquidRange: Math.min(Math.max(def.liquid_range ?? 8, 1), 8),
            model: null
        }
    }

    /** see read_tiledef in the engine for the defaults */
    private tileId(tile: Tile | undefined, alpha: AlphaMode, defaultCulling: boolean, forceCulling?: boolean): number {
        let name = typeof tile === "string" ? tile : tile?.name ?? ""
        let backfaceCulling = typeof tile === "object" && tile !== null ? tile.backface_culling ?? defaultCulling : defaultCulling
        if (name === "") {
            name = "no_texture.png"
            backfaceCulling = false
        }
        return this.tiles.getTile({
            texture: name,
            animation: typeof tile === "object" && tile !== null ? tile.animation : undefined,
            backfaceCulling: forceCulling ?? backfaceCulling,
            alpha
        })
    }

    private compileTiles(def: NodeDefinition, drawtype: ResolvedDrawType, alpha: AlphaMode): number[] {
        const tiles = Array.isArray(def.tiles) ? def.tiles : []
        const defaultCulling = !["plantlike", "firelike", "mesh", "liquid"].includes(drawtype)
        // these drawtypes are always rendered double sided / single sided by the engine
        let force: boolean | undefined
        if (["torchlike", "signlike", "raillike"].includes(drawtype)) {
            force = false
        } else if (drawtype === "normal" || drawtype === "plantlike_rooted") {
            force = true
        }
        const ids: number[] = []
        for (let i = 0; i < 6; i++) {
            // the last tile is repeated
            ids.push(this.tileId(tiles[Math.min(i, tiles.length - 1)], alpha, defaultCulling, force))
        }
        return ids
    }

    private compileSpecialTiles(def: NodeDefinition, drawtype: ResolvedDrawType, alpha: AlphaMode): number[] {
        const tiles = Array.isArray(def.special_tiles) ? def.special_tiles : []
        const ids: number[] = []
        for (let i = 0; i < 6; i++) {
            const tile = tiles[i]
            const name = typeof tile === "string" ? tile : tile?.name
            if (!name) {
                ids.push(-1)
                continue
            }
            // the plant of a rooted node is never opaque
            const tileAlpha = drawtype === "plantlike_rooted" && alpha === "opaque" ? "clip" : alpha
            ids.push(this.tileId(tile, tileAlpha, drawtype !== "plantlike_rooted"))
        }
        return ids
    }
}
