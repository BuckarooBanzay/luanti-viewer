import { computeNormals, type Model, type ModelBuffer } from "./model"

type Material = {
    name: string
    group: string
    positions: number[]
    normals: number[]
    uvs: number[]
    indices: number[]
    hasNormals: boolean
}

function newMaterial(name: string, group: string): Material {
    return { name, group, positions: [], normals: [], uvs: [], indices: [], hasNormals: true }
}

/**
 * Parses a wavefront obj file the way the engine does (irr/src/COBJMeshFileLoader.cpp):
 * every group ("g") becomes a separate buffer in order of first use and the
 * handedness is flipped (x and v are mirrored, the winding is reversed).
 */
export function parseObj(text: string): Model {
    const vertices: number[] = []
    const texCoords: number[] = []
    const normals: number[] = []

    const materials: Material[] = [newMaterial("", "")]
    let current = materials[0]!
    let materialName = ""
    let groupName = ""
    let materialChanged = false

    // mirrors findMtl() of the engine, material libraries are never loaded
    const findMaterial = (): Material | null => {
        let partial: Material | null = null
        for (const m of materials) {
            if (m.name === materialName) {
                if (m.group === groupName) {
                    return m
                }
                partial = m
            }
        }
        if (partial || groupName.length > 0) {
            const m = newMaterial(partial?.name ?? materials[0]!.name, groupName)
            materials.push(m)
            return m
        }
        return null
    }

    const resolve = (index: string | undefined, count: number): number => {
        if (!index) {
            return -1
        }
        const i = parseInt(index, 10)
        if (Number.isNaN(i)) {
            return -1
        }
        return i < 0 ? count + i : i - 1
    }

    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim()
        if (line === "" || line.startsWith("#")) {
            continue
        }
        const parts = line.split(/\s+/)
        switch (parts[0]) {
            case "v":
                vertices.push(-parseFloat(parts[1]!), parseFloat(parts[2]!), parseFloat(parts[3]!))
                break
            case "vn":
                normals.push(-parseFloat(parts[1]!), parseFloat(parts[2]!), parseFloat(parts[3]!))
                break
            case "vt":
                texCoords.push(parseFloat(parts[1]!), 1 - parseFloat(parts[2] ?? "0"))
                break
            case "g":
                groupName = parts[1] ?? "default"
                materialChanged = true
                break
            case "usemtl":
                materialName = parts[1] ?? ""
                materialChanged = true
                break
            case "f": {
                if (materialChanged) {
                    current = findMaterial() ?? current
                    materialChanged = false
                }
                const corners: number[] = []
                for (let i = 1; i < parts.length; i++) {
                    const [v, vt, vn] = parts[i]!.split("/")
                    const vi = resolve(v, vertices.length / 3)
                    if (vi < 0 || vi >= vertices.length / 3) {
                        throw new Error(`obj: invalid vertex index in line '${line}'`)
                    }
                    const ti = resolve(vt, texCoords.length / 2)
                    const ni = resolve(vn, normals.length / 3)
                    corners.push(current.positions.length / 3)
                    current.positions.push(vertices[vi * 3]!, vertices[vi * 3 + 1]!, vertices[vi * 3 + 2]!)
                    if (ti >= 0 && ti < texCoords.length / 2) {
                        current.uvs.push(texCoords[ti * 2]!, texCoords[ti * 2 + 1]!)
                    } else {
                        current.uvs.push(0, 0)
                    }
                    if (ni >= 0 && ni < normals.length / 3) {
                        current.normals.push(normals[ni * 3]!, normals[ni * 3 + 1]!, normals[ni * 3 + 2]!)
                    } else {
                        current.normals.push(0, 0, 0)
                        current.hasNormals = false
                    }
                }
                if (corners.length < 3) {
                    throw new Error(`obj: too few vertices in line '${line}'`)
                }
                // triangle fan with reversed winding
                for (let i = 1; i < corners.length - 1; i++) {
                    current.indices.push(corners[i + 1]!, corners[i]!, corners[0]!)
                }
                break
            }
        }
    }

    const buffers: ModelBuffer[] = []
    for (const m of materials) {
        if (m.indices.length === 0) {
            continue
        }
        const positions = new Float32Array(m.positions)
        const indices = new Uint32Array(m.indices)
        buffers.push({
            positions,
            indices,
            uvs: new Float32Array(m.uvs),
            normals: m.hasNormals ? new Float32Array(m.normals) : computeNormals(positions, indices)
        })
    }
    return { buffers }
}
