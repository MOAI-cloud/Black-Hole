# All-sky backgrounds

Gargantua samples these equirectangular panoramas in the escaping light ray's direction. The center column corresponds to simulation azimuth zero, longitude wraps once, and the upper edge is the north pole. Both renderers use this convention. The survey coordinates are attached to the simulation sky sphere; its alignment with the disk is a scene choice.

| Background | Image and credit |
| --- | --- |
| Milky Way | Visible-light GigaGalaxy Zoom panorama. ESO / Serge Brunier / Frédéric Tapissier. [ESO release](https://www.eso.org/public/news/eso0932/) |
| Deep star field | The repository's existing `starmap.ppm` panorama. |
| WISE infrared | NASA / JPL-Caltech / UCLA. WISE all-sky data release, equirectangular mosaic PIA15482. Cyan, green and red encode 3.4, 12 and 22 μm respectively. [NASA original and download](https://science.nasa.gov/photojournal/mapping-the-infrared-universe-the-entire-wise-sky-rectangular-format/) |
| Fermi gamma rays | NASA / DOE / Fermi LAT Collaboration. Five years of detections above 1 GeV, in the equidistant cylindrical Galactic projection. Display color encodes gamma-ray intensity. [NASA SVS original and download](https://svs.gsfc.nasa.gov/11342/) |
| Dark sky | Zero background radiance. |

The two survey backgrounds use the published display colors. They give the environment a different observational band while the disk keeps its thermal visible-light emission model. No image downloads are needed at runtime. `infrared.ppm` (2048 × 1024) and `gamma-ray.ppm` (1024 × 512) are the native textures. Their lossless WebP counterparts store the same RGB samples for the live viewer. Either native map can be used directly with `--starmap`, for example `--starmap skies/infrared.ppm`.
