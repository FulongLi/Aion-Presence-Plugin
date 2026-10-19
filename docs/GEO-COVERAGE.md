# Geographic coverage (measured)

Measured by `npm run geo:coverage` on 2026-10-19 against the live services: 42 of 42 regions passed (71 s, requests spaced for Nominatim's usage policy). Map: what was framed, by whom, the window in degrees, and the size of the map sent to the surface. Markers: the coordinates found (and by whom). Terrain: grid, elevation tiles zoom and source, real elevation range.

This is a sample across the hard cases, not a claim of complete worldwide coverage. Every one of Aion's offline regions (≈ 270 countries and named parts, plus continents and groups) is also checked offline by `tests/v41.test.ts` on every test run.

| Region | Case | Map | Markers | Terrain |
| --- | --- | --- | --- | --- |
| ✓ Africa | continent | Africa · natural-earth · 105.3° × 79.6° · 18141 vertices · 292 KB | Cape Town -33.92, 18.43 (natural-earth); Cairo 30.05, 31.25 (natural-earth) | 127×137 · aws-terrain-tiles z3 · natural-earth · 0–2927 m |
| ✓ Europe | continent | Europe · natural-earth · 132.9° × 46.5° · 21744 vertices · 355 KB | — | — |
| ✓ Asia | continent | Asia · natural-earth · 245.2° × 115.9° · 19865 vertices · 329 KB | — | — |
| ✓ North America | continent | North America · natural-earth · 213.7° × 98.9° · 11930 vertices · 191 KB | — | — |
| ✓ South America | continent | South America · natural-earth · 103.9° × 75.4° · 11223 vertices · 185 KB | Ushuaia -54.81, -68.31 (nominatim) | 104×150 · aws-terrain-tiles z3 · natural-earth · 0–4884 m |
| ✓ Oceania | continent | Oceania · natural-earth · 105.5° × 59.0° · 8052 vertices · 132 KB | — | — |
| ✓ Antarctica | continent · pole | Antarctica · natural-earth · 357.6° × 45.7° · 7945 vertices · 131 KB | — | 121×100 · aws-terrain-tiles z1 · natural-earth · 17–4075 m |
| ✓ World | world | The world · natural-earth · 359.4° × 180.0° · 19568 vertices · 316 KB | — | — |
| ✓ Arctic | pole | The Arctic · natural-earth · 357.6° × 42.5° · 23178 vertices · 385 KB | — | — |
| ✓ Russia | largest | Russia · natural-earth · 345.3° × 64.8° · 20782 vertices · 344 KB | — | 137×80 · aws-terrain-tiles z1 · natural-earth · 0–2607 m |
| ✓ Canada | largest | Canada · natural-earth · 179.1° × 56.4° · 21171 vertices · 343 KB | — | — |
| ✓ United States | largest | United States of America · natural-earth · 78.9° × 39.2° · 7723 vertices · 126 KB | Los Angeles 33.99, -118.18 (natural-earth); New York 40.75, -73.98 (natural-earth) | 140×94 · aws-terrain-tiles z3 · natural-earth · 0–3526 m |
| ✓ China | largest | China · natural-earth · 85.2° × 47.2° · 13954 vertices · 230 KB | — | — |
| ✓ 中国 | Chinese name | China · natural-earth · 85.2° × 47.2° · 13954 vertices · 230 KB | — | 140×117 · aws-terrain-tiles z3 · natural-earth · 1–5924 m |
| ✓ Brazil | largest | Brazil · natural-earth · 54.5° × 45.8° · 7197 vertices · 120 KB | — | — |
| ✓ Australia | largest | Australia · natural-earth · 59.2° × 41.2° · 4587 vertices · 75 KB | Sydney -33.92, 151.18 (natural-earth) | — |
| ✓ India | largest | India · natural-earth · 38.1° × 32.5° · 5859 vertices · 95 KB | — | — |
| ✓ Greenland | high latitude | Greenland · natural-earth · 126.5° × 28.8° · 6285 vertices · 103 KB | — | 77×140 · aws-terrain-tiles z2 · natural-earth · 1–3226 m |
| ✓ Svalbard | high latitude | Svalbard · natural-earth · 29.0° × 5.0° · 914 vertices · 15 KB | — | 139×139 · aws-terrain-tiles z4 · natural-earth · 0–1252 m |
| ✓ Iceland | high latitude | Iceland · natural-earth · 13.4° × 4.0° · 579 vertices · 10 KB | Reykjavik 64.15, -21.95 (natural-earth) | 140×98 · aws-terrain-tiles z6 · natural-earth · 0–1978 m |
| ✓ Norway | high latitude | Norway · natural-earth · 40.2° × 16.2° · 4583 vertices · 75 KB | — | — |
| ✓ Alaska | high latitude · OSM | Alaska · nominatim · 105.6° × 28.6° · 10938 vertices · 181 KB | — | 139×77 · aws-terrain-tiles z3 · nominatim · 0–2799 m |
| ✓ Fiji | date line | Fiji · natural-earth · 5.4° × 5.3° · 338 vertices · 6 KB | Suva -18.13, 178.44 (natural-earth) | 124×94 · aws-terrain-tiles z7 · natural-earth · 0–1040 m |
| ✓ Kiribati | date line | Kiribati · natural-earth · 0.8° × 0.8° · 27 vertices · 1 KB | — | — |
| ✓ New Zealand | date line | New Zealand · natural-earth · 16.5° × 15.2° · 967 vertices · 16 KB | — | 98×140 · aws-terrain-tiles z5 · natural-earth · 0–2025 m |
| ✓ Chukotka | date line · OSM | Чукотский автономный округ · nominatim · 49.6° × 13.9° · 4294 vertices · 71 KB | — | — |
| ✓ Singapore | small | Singapore · natural-earth · 0.8° × 0.8° · 72 vertices · 1 KB | — | — |
| ✓ Malta | small | Malta · natural-earth · 1.0° × 0.8° · 24 vertices · 1 KB | — | — |
| ✓ Luxembourg | small | Luxembourg · natural-earth · 1.3° × 0.8° · 117 vertices · 2 KB | — | — |
| ✓ Vatican City | small | Vatican · natural-earth · 1.1° × 0.8° · 28 vertices · 1 KB | — | — |
| ✓ Scotland | country part | Scotland · natural-earth · 9.3° × 7.2° · 1141 vertices · 19 KB | Glasgow 55.88, -4.25 (natural-earth); Edinburgh 55.95, -3.22 (natural-earth) | 80×140 · aws-terrain-tiles z6 · natural-earth · 0–1032 m |
| ✓ 苏格兰 | Chinese name | Scotland · natural-earth · 9.3° × 7.2° · 1143 vertices · 20 KB | — | — |
| ✓ Japan | archipelago | Japan · natural-earth · 26.1° × 22.7° · 2959 vertices · 49 KB | Kyoto 35.03, 135.75 (natural-earth) | 108×140 · aws-terrain-tiles z4 · natural-earth · 1–2184 m |
| ✓ 日本 | Chinese name | Japan · natural-earth · 26.1° × 22.7° · 2959 vertices · 49 KB | — | — |
| ✓ Indonesia | archipelago | Indonesia · natural-earth · 54.5° × 24.1° · 8089 vertices · 133 KB | — | — |
| ✓ California | state · OSM | California · nominatim · 13.3° × 11.2° · 1518 vertices · 26 KB | San Francisco 37.77, -122.42 (natural-earth) | 121×140 · aws-terrain-tiles z5 · nominatim · 0–3676 m |
| ✓ Bavaria | state · OSM | Bayern · nominatim · 5.9° × 3.9° · 2562 vertices · 42 KB | — | — |
| ✓ Hokkaido | island · OSM | 北海道 · nominatim · 8.5° × 5.4° · 718 vertices · 12 KB | — | — |
| ✓ 四川 | Chinese name · OSM | 四川省 · nominatim · 13.4° × 9.9° · 4906 vertices · 80 KB | — | — |
| ✓ Swiss Alps | range · OSM | Swiss Alps · nominatim · 4.4° × 2.1° · 1554 vertices · 26 KB | — | 140×92 · aws-terrain-tiles z7 · nominatim · 171–4183 m |
| ✓ Grand Canyon | landmark · OSM | Grand Canyon · nominatim · 4.2° × 3.3° · 4 vertices · 0 KB | — | 160×160 · aws-terrain-tiles z7 · nominatim · 370–3454 m |
| ✓ Mount Everest | point · OSM | 珠穆朗玛峰 ཇོ་མོ་གླང་མ། सगरमाथा · nominatim · 3.8° × 3.3° · 362 vertices · 6 KB | — | 160×160 · aws-terrain-tiles z7 · nominatim · 54–7667 m |
