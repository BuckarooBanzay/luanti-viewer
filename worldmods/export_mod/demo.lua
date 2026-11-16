-- places `count` meselamps along the x axis, `spacing` nodes apart, starting at `origin`
function mtwebview.place_meselamps(origin, count, spacing)
    origin = origin or vector.new(0, 0, 0)
    count = count or 20
    spacing = spacing or 16

    for i = 0, count - 1 do
        local pos = vector.add(origin, vector.new(i * spacing, 0, 0))
        minetest.set_node(pos, { name = "default:meselamp" })
    end
end

-- lays out every registered node of `modname` as a flat carpet (square grid, one node each)
-- on the x/z plane, starting at `origin`
function mtwebview.place_mod_carpet(modname, origin)
    origin = origin or vector.new(0, 0, 0)

    local names = {}
    local prefix = modname .. ":"
    for name in pairs(minetest.registered_nodes) do
        if name:sub(1, #prefix) == prefix then
            table.insert(names, name)
        end
    end
    table.sort(names)

    local width = math.ceil(math.sqrt(#names))
    for i, name in ipairs(names) do
        local x = (i - 1) % width
        local z = math.floor((i - 1) / width)
        minetest.set_node(vector.add(origin, vector.new(x, 0, z)), { name = name })
    end
end
