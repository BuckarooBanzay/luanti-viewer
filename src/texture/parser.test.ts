import { describe, expect, it } from "vitest"
import { parseColorString, parseTexture, parseTransform, splitEscaped } from "./parser"

describe("parseTexture", () => {
    it("parses a plain file name", () => {
        expect(parseTexture("default_stone.png")).toEqual([{ type: "file", name: "default_stone.png" }])
    })

    it("parses overlays and modifiers from left to right", () => {
        expect(parseTexture("default_dirt.png^default_grass_side.png^[transformR90^[colorize:#fff:80")).toEqual([
            { type: "file", name: "default_dirt.png" },
            { type: "file", name: "default_grass_side.png" },
            { type: "modifier", name: "transform", args: "R90" },
            { type: "modifier", name: "colorize", args: "#fff:80" }
        ])
    })

    it("parses groups", () => {
        expect(parseTexture("a.png^(b.png^[opacity:127)^[noalpha")).toEqual([
            { type: "file", name: "a.png" },
            { type: "group", parts: [{ type: "file", name: "b.png" }, { type: "modifier", name: "opacity", args: "127" }] },
            { type: "modifier", name: "noalpha", args: "" }
        ])
    })

    it("keeps escaped separators inside of modifier arguments", () => {
        const parts = parseTexture("[combine:16x32:0,0=a.png\\^[transformFX:0,16=b.png")
        expect(parts).toEqual([{ type: "modifier", name: "combine", args: "16x32:0,0=a.png\\^[transformFX:0,16=b.png" }])
        expect(splitEscaped("16x32:0,0=a.png\\:x:0,16=b.png", ":")).toEqual(["16x32", "0,0=a.png\\:x", "0,16=b.png"])
    })
})

describe("parseTransform", () => {
    it("parses names and numbers", () => {
        expect(parseTransform("")).toBe(0)
        expect(parseTransform("I")).toBe(0)
        expect(parseTransform("R90")).toBe(1)
        expect(parseTransform("R180")).toBe(2)
        expect(parseTransform("r270")).toBe(3)
        expect(parseTransform("FX")).toBe(4)
        expect(parseTransform("FY")).toBe(6)
        expect(parseTransform("3")).toBe(3)
        expect(parseTransform("6")).toBe(6)
    })

    it("combines multiple transformations", () => {
        expect(parseTransform("FXR90")).toBe(5)
        expect(parseTransform("FYR90")).toBe(7)
        expect(parseTransform("R90R90")).toBe(2)
        expect(parseTransform("FXFX")).toBe(0)
        expect(parseTransform("46")).toBe(2)
    })
})

describe("parseColorString", () => {
    it("parses hex colors and names", () => {
        expect(parseColorString("#fff")).toEqual([255, 255, 255, 255])
        expect(parseColorString("#f008")).toEqual([255, 0, 0, 136])
        expect(parseColorString("#102030")).toEqual([16, 32, 48, 255])
        expect(parseColorString("#10203040")).toEqual([16, 32, 48, 64])
        expect(parseColorString("red")).toEqual([255, 0, 0, 255])
        expect(parseColorString("blue#80")).toEqual([0, 0, 255, 128])
        expect(parseColorString("nonsense")).toBeNull()
        expect(parseColorString("#12")).toBeNull()
    })
})
