function mtwebview.export_nodedefs()
    local count = 0
    local nodedefs = {}

    for name, def in pairs(minetest.registered_nodes) do
        count = count + 1
        local exported_def = {
            name = name,
            drawtype = def.drawtype,
            paramtype = def.paramtype,
            paramtype2 = def.paramtype2,
            light_source = def.light_source,
            mesh = def.mesh,
            tiles = def.tiles,
            special_tiles = def.special_tiles,
            overlay_tiles = def.overlay_tiles,
            use_texture_alpha = def.use_texture_alpha,
            visual_scale = def.visual_scale,
            color = def.color,
            palette = def.palette,
            waving = def.waving,
            node_box = def.node_box,
            connects_to = def.connects_to,
            connect_sides = def.connect_sides,
            groups = def.groups
        }

        if def.drawtype == "liquid" or def.drawtype == "flowingliquid" then
            exported_def.post_effect_color = def.post_effect_color
            exported_def.liquid_alternative_source = def.liquid_alternative_source
            exported_def.liquid_alternative_flowing = def.liquid_alternative_flowing
            exported_def.liquid_range = def.liquid_range
        end

        nodedefs[name] = exported_def
    end

    local size = mtwebview.export_json(mtwebview.basepath .. "/nodedefs.json", nodedefs, true)

    print("[mtwebview] exported " .. count .. " node-definitions (" .. size .. " bytes)")
end