export type DrawType =
    | "airlike"
    | "normal"
    | "nodebox"
    | "mesh"
    | "plantlike"
    | "plantlike_rooted"
    | "raillike"
    | "signlike"
    | "firelike"
    | "liquid"
    | "flowingliquid"
    | "allfaces_optional"
    | "glasslike"
    | "glasslike_framed"
    | "glasslike_framed_optional"

export type ParamType = "none" | "light"

export type ParamType2 =
    | "none"
    | "facedir"
    | "wallmounted"
    | "meshoptions"
    | "flowingliquid"
    | "leveled"

export type TileAnimation = {
    type: "vertical_frames"
    aspect_w: number
    aspect_h: number
    length: number
}

export type TileDefinition = {
    name: string
    backface_culling?: boolean
    tileable_vertical?: boolean
    align_style?: "node" | "world" | "user"
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
        type: "fixed"
        fixed: BoxList
    }
    | {
        type: "connected"
        fixed: BoxList
        connect_front: BoxList
        connect_back: BoxList
        connect_left: BoxList
        connect_right: BoxList
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

export type NodeDefinition = {
    name: string
    drawtype: DrawType
    paramtype: ParamType
    paramtype2: ParamType2
    light_source: number
    /** group name -> rating, null if the node has no groups */
    groups: Record<string, number> | null
    /** up to 6 entries, absent on airlike nodes */
    tiles?: Tile[]
    /** only present for drawtype "nodebox" */
    node_box?: NodeBox
    /** mesh file name (.obj / .b3d), only present for drawtype "mesh" */
    mesh?: string
    /** node names or "group:<name>", only present for connected nodeboxes */
    connects_to?: string[]
    post_effect_color?: Color
}

export type MapblockPosition = {
    x: number,
    y: number,
    z: number
}

/**
 * Mapblock data
 */
export type Mapblock = {
    mapdata: string,
    node_mapping: Map<string, number>
}

type ViewerOptions = {
    getNodeDefinitions: Promise<Map<string, NodeDefinition>>
    getMapblock(pos: MapblockPosition): Promise<Mapblock|null>
    minPos: MapblockPosition,
    maxPos: MapblockPosition
}

export function createView(element: HTMLElement, options: ViewerOptions): void {}