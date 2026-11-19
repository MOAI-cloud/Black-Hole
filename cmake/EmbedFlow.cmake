# Embed the same packed asset used by WebGL, keeping the CLI relocatable.
file(READ "${INPUT}" bytes HEX)
string(REPEAT "[0-9a-f]" 32 line)
string(REGEX REPLACE "(${line})" "\\1\n" bytes "${bytes}")
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," bytes "${bytes}")
file(WRITE "${OUTPUT}" "#include \"flow/atlas.h\"\nnamespace grmhd { const unsigned char atlas[frames*radii*azimuths*2] = { ${bytes} }; }\n")
