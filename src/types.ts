import type { ParsedMapblock } from "./mapblock"

/** all drawtypes of the luanti engine */
export type DrawType =
    | "normal"
    | "airlike"
    | "liquid"
    | "flowingliquid"
    | "glasslike"
    | "glasslike_framed"
    | "glasslike_framed_optional"
    | "allfaces"
    | "allfaces_optional"
    | "torchlike"
    | "signlike"
    | "plantlike"
    | "firelike"
    | "fencelike"
    | "raillike"
    | "nodebox"
    | "mesh"
    | "plantlike_rooted"

export type ParamType = "none" | "light"

export type ParamType2 =
    | "none"
    | "facedir"
    | "4dir"
    | "wallmounted"
    | "meshoptions"
    | "flowingliquid"
    | "leveled"
    | "degrotate"
    | "glasslikeliquidlevel"
    | "color"
    | "colorfacedir"
    | "color4dir"
    | "colorwallmounted"
    | "colordegrotate"

export type TileAnimation =
    | {
        type: "vertical_frames"
        aspect_w?: number
        aspect_h?: number
        /** duration of the whole animation in seconds */
        length?: number
    }
    | {
        type: "sheet_2d"
        frames_w: number
        frames_h: number
        /** duration of a single frame in seconds */
        frame_length: number
    }

export type TileDefinition = {
    name: string
    backface_culling?: boolean
    tileable_vertical?: boolean
    tileable_horizontal?: boolean
    align_style?: "node" | "world" | "user"
    scale?: number
    animation?: TileAnimation
}

/** either a texture name (with optional texture modifiers) or a full tile definition */
export type Tile = string | TileDefinition

/** [x1, y1, z1, x2, y2, z2] */
export type Box = [number, number, number, number, number, number]

/** a single box or a list of boxes */
export type BoxList = Box | Box[]

export type NodeBox =
    | {
        type: "regular"
    }
    | {
        type: "fixed" | "leveled"
        fixed: BoxList
    }
    | {
        type: "connected"
        fixed?: BoxList
        connect_top?: BoxList
        connect_bottom?: BoxList
        connect_front?: BoxList
        connect_back?: BoxList
        connect_left?: BoxList
        connect_right?: BoxList
        disconnected_top?: BoxList
        disconnected_bottom?: BoxList
        disconnected_front?: BoxList
        disconnected_back?: BoxList
        disconnected_left?: BoxList
        disconnected_right?: BoxList
        /** used when no neighbor is connected */
        disconnected?: BoxList
        /** used when no horizontal neighbor is connected */
        disconnected_sides?: BoxList
    }
    | {
        type: "wallmounted"
        wall_top: Box
        wall_bottom: Box
        wall_side: Box
    }

export type Color = {
    r: number
    g: number
    b: number
    a: number
}

export type AlphaMode = "opaque" | "clip" | "blend"

export type NodeDefinition = {
    name: string
    drawtype: DrawType
    paramtype: ParamType
    paramtype2: ParamType2
    light_source: number
    /** group name -> rating, null if the node has no groups */
    groups: Record<string, number> | null
    /** up to 6 entries, absent on airlike nodes */
    tiles?: Tile[] | null
    /** additional tiles used by flowing liquids, rooted plants and framed glass */
    special_tiles?: Tile[] | null
    /** engine default depends on the drawtype if absent, the boolean form is the legacy api */
    use_texture_alpha?: AlphaMode | boolean | null
    /** scale factor for plants, signs, torches and meshes, defaults to 1 */
    visual_scale?: number | null
    /** colorstring the textures are multiplied with */
    color?: string | Color | null
    /** only present for drawtype "nodebox" */
    node_box?: NodeBox | null
    /** mesh file name (.obj / .b3d), only present for drawtype "mesh" */
    mesh?: string | null
    /** node names or "group:<name>", only present for connected nodeboxes */
    connects_to?: string[] | null
    /** only present on liquids */
    liquid_alternative_source?: string | null
    liquid_alternative_flowing?: string | null
    /** defaults to 8 */
    liquid_range?: number | null
    post_effect_color?: Color | null
}

export type MapblockPosition = {
    x: number,
    y: number,
    z: number
}

export type ViewerOptions = {
    /** fetches the definition of a single node, null if the node is unknown, called once per node name */
    getNodeDefinitions(nodename: string): Promise<NodeDefinition|null>
    getMapblock(pos: MapblockPosition): Promise<ParsedMapblock|null>
    /** fetches a texture (.png) or model (.obj / .b3d) by its file name, null if it does not exist */
    getMedia(filename: string): Promise<Blob|null>
    minPos: MapblockPosition,
    maxPos: MapblockPosition
    /** initial camera in node coordinates, defaults to an overview of the whole scene */
    camera?: {
        position: { x: number, y: number, z: number }
        target: { x: number, y: number, z: number }
    }
}
