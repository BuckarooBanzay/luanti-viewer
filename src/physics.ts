/** player collision box (nodes), the engine's default: 0.6 wide and 1.77 high, the position is at the feet */
export const PLAYER_HALF_WIDTH = 0.3
export const PLAYER_HEIGHT = 1.77
/** height of the eyes above the feet */
export const PLAYER_EYE_HEIGHT = 1.625

/** tolerance against floating point errors, boxes touching a node face do not overlap it */
const EPSILON = 1e-6

/** the part of the world the collision needs */
export type SolidQuery = {
    /** true if the node at the integer node position blocks the player */
    isSolid(x: number, y: number, z: number): boolean
}

export type CollisionResult = {
    /** the position after the movement (center of the feet) */
    x: number
    y: number
    z: number
    /** the movement was stopped by a node on the axis */
    hitX: boolean
    hitY: boolean
    hitZ: boolean
    /** the player stands on a node (moving down was blocked) */
    onGround: boolean
}

/** true if the player box does not overlap a solid node */
export function isFree(
    world: SolidQuery, x: number, y: number, z: number, halfWidth = PLAYER_HALF_WIDTH, height = PLAYER_HEIGHT
): boolean {
    const x0 = Math.floor(x - halfWidth + 0.5 + EPSILON), x1 = Math.floor(x + halfWidth + 0.5 - EPSILON)
    const y0 = Math.floor(y + 0.5 + EPSILON), y1 = Math.floor(y + height + 0.5 - EPSILON)
    const z0 = Math.floor(z - halfWidth + 0.5 + EPSILON), z1 = Math.floor(z + halfWidth + 0.5 - EPSILON)
    for (let nz = z0; nz <= z1; nz++) {
        for (let ny = y0; ny <= y1; ny++) {
            for (let nx = x0; nx <= x1; nx++) {
                if (world.isSolid(nx, ny, nz)) {
                    return false
                }
            }
        }
    }
    return true
}

/**
 * Moves the player box by `dx, dy, dz` and stops it at solid nodes, all in engine coordinates:
 * a node at integer position `n` fills the range `n - 0.5 .. n + 0.5` on every axis.
 * The axes are resolved one after the other (y, x, z), so the box slides along walls and floors.
 */
export function collide(
    world: SolidQuery, x: number, y: number, z: number, dx: number, dy: number, dz: number,
    halfWidth = PLAYER_HALF_WIDTH, height = PLAYER_HEIGHT
): CollisionResult {
    // box minimum and size per axis (x, y, z)
    const min = [x - halfWidth, y, z - halfWidth]
    const size = [halfWidth * 2, height, halfWidth * 2]
    const hit = [false, false, false]

    const move = (axis: number, delta: number) => {
        if (delta === 0) {
            return
        }
        const a = axis, b = (axis + 1) % 3, c = (axis + 2) % 3
        // node range overlapped by the box on the two other axes
        const b0 = Math.floor(min[b]! + 0.5 + EPSILON), b1 = Math.floor(min[b]! + size[b]! + 0.5 - EPSILON)
        const c0 = Math.floor(min[c]! + 0.5 + EPSILON), c1 = Math.floor(min[c]! + size[c]! + 0.5 - EPSILON)
        const solid = (n: number) => {
            const p = [0, 0, 0]
            p[a] = n
            for (let i = b0; i <= b1; i++) {
                for (let j = c0; j <= c1; j++) {
                    p[b] = i
                    p[c] = j
                    if (world.isSolid(p[0]!, p[1]!, p[2]!)) {
                        return true
                    }
                }
            }
            return false
        }

        let allowed = delta
        if (delta > 0) {
            const front = min[a]! + size[a]!
            // nodes whose lower face is at or beyond the front of the box
            for (let n = Math.ceil(front - 0.5 - EPSILON); n - 0.5 < front + delta; n++) {
                if (solid(n)) {
                    allowed = Math.max(n - 0.5 - front, 0)
                    hit[a] = true
                    break
                }
            }
        } else {
            const back = min[a]!
            // nodes whose upper face is at or below the back of the box
            for (let n = Math.floor(back - 0.5 + EPSILON); n + 0.5 > back + delta; n--) {
                if (solid(n)) {
                    allowed = Math.min(n + 0.5 - back, 0)
                    hit[a] = true
                    break
                }
            }
        }
        min[a] = min[a]! + allowed
    }

    move(1, dy)
    move(0, dx)
    move(2, dz)

    return {
        x: min[0]! + halfWidth, y: min[1]!, z: min[2]! + halfWidth,
        hitX: hit[0]!, hitY: hit[1]!, hitZ: hit[2]!,
        onGround: dy < 0 && hit[1]!
    }
}
