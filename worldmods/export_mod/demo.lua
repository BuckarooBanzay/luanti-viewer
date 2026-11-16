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
