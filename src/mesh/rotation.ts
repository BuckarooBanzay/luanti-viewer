/**
 * Rotation helpers that mirror the conventions of the luanti engine
 * (left-handed coordinates, angles in degrees, see irr/include/vector3d.h)
 */

/** row-major 3x3 matrix */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

const DEG = Math.PI / 180

function sinCos(degrees: number): [number, number] {
    // exact results for the right angles used by facedir rotations
    const quarter = degrees / 90
    if (Number.isInteger(quarter)) {
        const q = ((quarter % 4) + 4) % 4
        return [[0, 1, 0, -1][q]!, [1, 0, -1, 0][q]!]
    }
    return [Math.sin(degrees * DEG), Math.cos(degrees * DEG)]
}

/** equivalent of vector3d::rotateXZBy */
export function rotationXZ(degrees: number): Mat3 {
    const [s, c] = sinCos(degrees)
    return [c, 0, -s, 0, 1, 0, s, 0, c]
}

/** equivalent of vector3d::rotateXYBy */
export function rotationXY(degrees: number): Mat3 {
    const [s, c] = sinCos(degrees)
    return [c, -s, 0, s, c, 0, 0, 0, 1]
}

/** equivalent of vector3d::rotateYZBy */
export function rotationYZ(degrees: number): Mat3 {
    const [s, c] = sinCos(degrees)
    return [1, 0, 0, 0, c, -s, 0, s, c]
}

/** a * b: applies b first, then a */
export function multiply(a: Mat3, b: Mat3): Mat3 {
    const m: number[] = []
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            m.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!)
        }
    }
    return m as unknown as Mat3
}

/** rotates the vector at offset `o` of `v` in place */
export function applyMat3(m: Mat3, v: number[] | Float32Array, o = 0): void {
    const x = v[o]!, y = v[o + 1]!, z = v[o + 2]!
    v[o] = m[0] * x + m[1] * y + m[2] * z
    v[o + 1] = m[3] * x + m[4] * y + m[5] * z
    v[o + 2] = m[6] * x + m[7] * y + m[8] * z
}

/** see rotateMeshBy6dFacedir / transformNodeBox in the engine: rotation around y first, then the axis */
function buildFacedirMatrix(facedir: number): Mat3 {
    const axisdir = facedir >> 2
    let m = IDENTITY
    switch (facedir & 3) {
        case 1: m = rotationXZ(-90); break
        case 2: m = rotationXZ(180); break
        case 3: m = rotationXZ(90); break
    }
    switch (axisdir) {
        case 1: m = multiply(rotationYZ(90), m); break // z+
        case 2: m = multiply(rotationYZ(-90), m); break // z-
        case 3: m = multiply(rotationXY(-90), m); break // x+
        case 4: m = multiply(rotationXY(90), m); break // x-
        case 5: m = multiply(rotationXY(-180), m); break // y-
    }
    return m
}

const FACEDIR_MATRICES: Mat3[] = Array.from({ length: 24 }, (_, i) => buildFacedirMatrix(i))

/** rotation matrix for a facedir value (0..23) */
export function facedirMatrix(facedir: number): Mat3 {
    return FACEDIR_MATRICES[facedir] ?? IDENTITY
}

/** wallmounted param2 -> facedir, used for meshes and nodeboxes */
export const WALLMOUNTED_TO_FACEDIR: readonly number[] = [20, 0, 16 + 1, 12 + 3, 8, 4 + 2, 20 + 1, 0 + 1]

/** tile rotations in 90 degree steps */
const R0 = 0, R1 = 1, R2 = 2, R3 = 3

/**
 * facedir -> direction index -> [tile, rotation], see getNodeTile in the engine.
 * The direction index is (x + 2*y + 3*z) & 7
 */
export const FACEDIR_TILES: readonly (readonly (readonly [number, number])[])[] = [
    //  0        +X        +Y        +Z                 -Z        -Y        -X
    [[0, R0], [2, R0], [0, R0], [4, R0], [0, R0], [5, R0], [1, R0], [3, R0]], // rotate around y+ 0 - 3
    [[0, R0], [4, R0], [0, R3], [3, R0], [0, R0], [2, R0], [1, R1], [5, R0]],
    [[0, R0], [3, R0], [0, R2], [5, R0], [0, R0], [4, R0], [1, R2], [2, R0]],
    [[0, R0], [5, R0], [0, R1], [2, R0], [0, R0], [3, R0], [1, R3], [4, R0]],

    [[0, R0], [2, R3], [5, R0], [0, R2], [0, R0], [1, R0], [4, R2], [3, R1]], // rotate around z+ 4 - 7
    [[0, R0], [4, R3], [2, R0], [0, R1], [0, R0], [1, R1], [3, R2], [5, R1]],
    [[0, R0], [3, R3], [4, R0], [0, R0], [0, R0], [1, R2], [5, R2], [2, R1]],
    [[0, R0], [5, R3], [3, R0], [0, R3], [0, R0], [1, R3], [2, R2], [4, R1]],

    [[0, R0], [2, R1], [4, R2], [1, R2], [0, R0], [0, R0], [5, R0], [3, R3]], // rotate around z- 8 - 11
    [[0, R0], [4, R1], [3, R2], [1, R3], [0, R0], [0, R3], [2, R0], [5, R3]],
    [[0, R0], [3, R1], [5, R2], [1, R0], [0, R0], [0, R2], [4, R0], [2, R3]],
    [[0, R0], [5, R1], [2, R2], [1, R1], [0, R0], [0, R1], [3, R0], [4, R3]],

    [[0, R0], [0, R3], [3, R3], [4, R1], [0, R0], [5, R3], [2, R3], [1, R3]], // rotate around x+ 12 - 15
    [[0, R0], [0, R2], [5, R3], [3, R1], [0, R0], [2, R3], [4, R3], [1, R0]],
    [[0, R0], [0, R1], [2, R3], [5, R1], [0, R0], [4, R3], [3, R3], [1, R1]],
    [[0, R0], [0, R0], [4, R3], [2, R1], [0, R0], [3, R3], [5, R3], [1, R2]],

    [[0, R0], [1, R1], [2, R1], [4, R3], [0, R0], [5, R1], [3, R1], [0, R1]], // rotate around x- 16 - 19
    [[0, R0], [1, R2], [4, R1], [3, R3], [0, R0], [2, R1], [5, R1], [0, R0]],
    [[0, R0], [1, R3], [3, R1], [5, R3], [0, R0], [4, R1], [2, R1], [0, R3]],
    [[0, R0], [1, R0], [5, R1], [2, R3], [0, R0], [3, R1], [4, R1], [0, R2]],

    [[0, R0], [3, R2], [1, R2], [4, R2], [0, R0], [5, R2], [0, R2], [2, R2]], // rotate around y- 20 - 23
    [[0, R0], [5, R2], [1, R3], [3, R2], [0, R0], [2, R2], [0, R1], [4, R2]],
    [[0, R0], [2, R2], [1, R0], [5, R2], [0, R0], [4, R2], [0, R0], [3, R2]],
    [[0, R0], [4, R2], [1, R1], [2, R2], [0, R0], [3, R2], [0, R3], [5, R2]]
]
