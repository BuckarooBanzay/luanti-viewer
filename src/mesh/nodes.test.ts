import { describe, expect, it } from "vitest"
import type { NodeDefinition } from "../types.js"
import { NodeRegistry } from "./nodes.js"

const base = { paramtype: "light", paramtype2: "none", light_source: 0, groups: null } as const

const definitions: NodeDefinition[] = [
    { ...base, name: "air", drawtype: "airlike" },
    { ...base, name: "stone", drawtype: "normal", paramtype: "none", tiles: ["stone.png"] },
    // the liquids reference each other
    {
        ...base, name: "water_source", drawtype: "liquid", tiles: ["water.png"],
        liquid_alternative_source: "water_source", liquid_alternative_flowing: "water_flowing"
    },
    {
        ...base, name: "water_flowing", drawtype: "flowingliquid", special_tiles: ["water.png", "water.png"],
        liquid_alternative_source: "water_source", liquid_alternative_flowing: "water_flowing"
    }
]

function setup() {
    const requested: string[] = []
    const nodes = new NodeRegistry(async name => {
        requested.push(name)
        return definitions.find(def => def.name === name) ?? null
    }, { getTile: () => 0 })
    return { nodes, requested }
}

describe("NodeRegistry", () => {
    it("fetches the definitions on demand", async () => {
        const { nodes, requested } = setup()
        await nodes.ensure(["stone"])
        expect(requested).toEqual(["stone"])
        expect(nodes.infos[nodes.getId("stone")]!.drawtype).toBe("normal")
        expect(nodes.infos[nodes.getId("stone")]!.def).toBe(definitions[1])
    })

    it("requests every definition only once", async () => {
        const { nodes, requested } = setup()
        await Promise.all([nodes.ensure(["stone", "air"]), nodes.ensure(["stone"])])
        await nodes.ensure(["air", "stone", "unknown", "unknown"])
        await nodes.ensure(["unknown"])
        expect(requested.sort()).toEqual(["air", "stone", "unknown"])
    })

    it("fetches the referenced liquid alternatives", async () => {
        const { nodes, requested } = setup()
        await nodes.ensure(["water_source"])
        expect(requested.sort()).toEqual(["water_flowing", "water_source"])
        expect(nodes.infos[nodes.getId("water_flowing")]!.drawtype).toBe("flowingliquid")
    })

    it("falls back to a placeholder for unknown nodes and to the built-in air", async () => {
        const { nodes } = setup()
        await nodes.ensure(["missing"])
        expect(nodes.infos[nodes.getId("missing")]!.def.tiles).toEqual(["unknown_node.png"])

        const empty = new NodeRegistry(async () => null, { getTile: () => 0 })
        await empty.ensure(["air"])
        expect(empty.infos[empty.airId]!.isAir).toBe(true)
        expect(empty.infos[empty.airId]!.drawtype).toBe("airlike")
    })
})
