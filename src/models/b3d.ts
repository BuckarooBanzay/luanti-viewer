import { computeNormals, type Model, type ModelBuffer } from "./model"

/** column-major 4x4 matrix */
type Mat4 = number[]

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function multiply(a: Mat4, b: Mat4): Mat4 {
    const m = new Array<number>(16)
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let sum = 0
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + r]! * b[c * 4 + k]!
            }
            m[c * 4 + r] = sum
        }
    }
    return m
}

/**
 * local transformation of a b3d node: translation * rotation * scale.
 * The rotation is the transposed standard quaternion matrix, this is the
 * convention of the (left-handed) irrlicht quaternion class.
 */
function nodeMatrix(p: number[], s: number[], q: number[]): Mat4 {
    const [w, x, y, z] = q as [number, number, number, number]
    const len = Math.hypot(w, x, y, z) || 1
    const qw = w / len, qx = x / len, qy = y / len, qz = z / len
    const r = [
        1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
        2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
        2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)
    ]
    // r is row-major, used as column-major it is the transposed rotation
    return [
        r[0]! * s[0]!, r[1]! * s[0]!, r[2]! * s[0]!, 0,
        r[3]! * s[1]!, r[4]! * s[1]!, r[5]! * s[1]!, 0,
        r[6]! * s[2]!, r[7]! * s[2]!, r[8]! * s[2]!, 0,
        p[0]!, p[1]!, p[2]!, 1
    ]
}

/**
 * Parses the static geometry of a blitz3d file, see irr/src/CB3DMeshFileLoader.cpp.
 * Every TRIS chunk becomes a buffer, bones and animations are ignored.
 */
export function parseB3d(data: ArrayBuffer): Model {
    const view = new DataView(data)
    const buffers: ModelBuffer[] = []
    let animated = false

    const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))
    const floats = (o: number, n: number) => Array.from({ length: n }, (_, i) => view.getFloat32(o + i * 4, true))

    if (data.byteLength < 12 || tag(0) !== "BB3D") {
        throw new Error("b3d: missing BB3D header")
    }

    /** iterates over the chunks in [start, end) */
    const chunks = (start: number, end: number, fn: (name: string, bodyStart: number, bodyEnd: number) => void) => {
        let o = start
        while (o + 8 <= end) {
            const length = view.getInt32(o + 4, true)
            const bodyEnd = o + 8 + length
            if (length < 0 || bodyEnd > data.byteLength) {
                throw new Error("b3d: invalid chunk length")
            }
            fn(tag(o), o + 8, bodyEnd)
            o = bodyEnd
        }
    }

    const readMesh = (start: number, end: number, matrix: Mat4) => {
        let positions: number[] = []
        let normals: number[] = []
        let uvs: number[] = []
        let hasNormals = false

        // skip the brush id
        chunks(start + 4, end, (name, bodyStart, bodyEnd) => {
            if (name === "VRTS") {
                const flags = view.getInt32(bodyStart, true)
                const texCoordSets = view.getInt32(bodyStart + 4, true)
                const texCoordSize = view.getInt32(bodyStart + 8, true)
                hasNormals = (flags & 1) !== 0
                const stride = (3 + (flags & 1 ? 3 : 0) + (flags & 2 ? 4 : 0) + texCoordSets * texCoordSize) * 4
                for (let o = bodyStart + 12; o + stride <= bodyEnd; o += stride) {
                    const [x, y, z] = floats(o, 3) as [number, number, number]
                    positions.push(
                        matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
                        matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
                        matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!
                    )
                    let p = o + 12
                    if (flags & 1) {
                        const [nx, ny, nz] = floats(p, 3) as [number, number, number]
                        const rx = matrix[0]! * nx + matrix[4]! * ny + matrix[8]! * nz
                        const ry = matrix[1]! * nx + matrix[5]! * ny + matrix[9]! * nz
                        const rz = matrix[2]! * nx + matrix[6]! * ny + matrix[10]! * nz
                        const len = Math.hypot(rx, ry, rz) || 1
                        normals.push(rx / len, ry / len, rz / len)
                        p += 12
                    }
                    if (flags & 2) {
                        p += 16
                    }
                    if (texCoordSets >= 1 && texCoordSize >= 2) {
                        uvs.push(view.getFloat32(p, true), view.getFloat32(p + 4, true))
                    } else {
                        uvs.push(0, 0)
                    }
                }
            } else if (name === "TRIS") {
                const indices: number[] = []
                const count = positions.length / 3
                for (let o = bodyStart + 4; o + 12 <= bodyEnd; o += 12) {
                    const a = view.getInt32(o, true), b = view.getInt32(o + 4, true), c = view.getInt32(o + 8, true)
                    if (a < 0 || b < 0 || c < 0 || a >= count || b >= count || c >= count) {
                        throw new Error("b3d: triangle references an unknown vertex")
                    }
                    indices.push(a, b, c)
                }
                const p = new Float32Array(positions)
                const i = new Uint32Array(indices)
                buffers.push({
                    positions: p,
                    indices: i,
                    uvs: new Float32Array(uvs),
                    normals: hasNormals ? new Float32Array(normals) : computeNormals(p, i)
                })
            }
        })
    }

    const readNode = (start: number, end: number, parent: Mat4) => {
        // zero-terminated name
        let o = start
        while (o < end && view.getUint8(o) !== 0) {
            o++
        }
        o++
        if (o + 40 > end) {
            throw new Error("b3d: truncated NODE chunk")
        }
        const matrix = multiply(parent, nodeMatrix(floats(o, 3), floats(o + 12, 3), floats(o + 24, 4)))
        chunks(o + 40, end, (name, bodyStart, bodyEnd) => {
            if (name === "NODE") {
                readNode(bodyStart, bodyEnd, matrix)
            } else if (name === "MESH") {
                readMesh(bodyStart, bodyEnd, matrix)
            } else if (name === "BONE" || name === "KEYS") {
                animated = true
            }
        })
    }

    // BB3D body: version, then chunks
    chunks(12, Math.min(data.byteLength, 8 + view.getInt32(4, true)), (name, bodyStart, bodyEnd) => {
        if (name === "NODE") {
            readNode(bodyStart, bodyEnd, IDENTITY)
        }
    })

    if (animated) {
        // compatibility quirk of the engine: animated meshes are not scaled by BS (10 units per node)
        for (const buffer of buffers) {
            for (let i = 0; i < buffer.positions.length; i++) {
                buffer.positions[i] = buffer.positions[i]! / 10
            }
        }
    }

    return { buffers }
}
