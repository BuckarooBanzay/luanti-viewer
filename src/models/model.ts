/**
 * A static model in the conventions of the luanti engine:
 * left-handed coordinates, one unit per node, texture origin in the top left corner
 * and triangles whose (b - a) x (c - a) points away from the surface.
 */
export type ModelBuffer = {
    /** xyz per vertex */
    positions: Float32Array
    /** xyz per vertex */
    normals: Float32Array
    /** uv per vertex */
    uvs: Float32Array
    indices: Uint32Array
}

/** the buffer at index n is textured with tile n of the node */
export type Model = {
    buffers: ModelBuffer[]
}

/** fills in flat normals for all vertices of the triangles, used when the file has none */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const normals = new Float32Array(positions.length)
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3
        const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!
        const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
        for (const o of [a, b, c]) {
            normals[o] = normals[o]! + nx
            normals[o + 1] = normals[o + 1]! + ny
            normals[o + 2] = normals[o + 2]! + nz
        }
    }
    for (let o = 0; o < normals.length; o += 3) {
        const len = Math.hypot(normals[o]!, normals[o + 1]!, normals[o + 2]!)
        if (len > 0) {
            normals[o] = normals[o]! / len
            normals[o + 1] = normals[o + 1]! / len
            normals[o + 2] = normals[o + 2]! / len
        }
    }
    return normals
}
