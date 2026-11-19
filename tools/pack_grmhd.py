"""Pack the Illinois v3 SANE a=+0.5 equatorial movie. See src/flow/README.md."""
import argparse
from pathlib import Path

import h5py
import numpy as np


def equatorial_activity(prims):
    """Invariant magnetic pressure and thermal pressure in the native FMKS metric."""
    r = np.exp(.5014684328448891 + (np.arange(190)[:, None, None] + .5) * .022244051549087665)
    x2 = (np.arange(60, 68)[None, :, None] + .5) / 128
    hslope, alpha, xt, spin = .3, 14, .82, .5
    norm = .5 * np.pi / (1 + (1 / xt)**alpha / (alpha + 1))
    y = 2 * x2 - 1
    th_g = np.pi*x2 + .5*(1-hslope)*np.sin(2*np.pi*x2)
    th_j = np.pi/2 + norm*y*(1 + (y/xt)**alpha / (alpha+1))
    blend = np.exp(.5*(.5014684328448891 - np.log(r)))
    th = th_g + blend*(th_j - th_g)
    dth1 = -.5*blend*(th_j - th_g)
    dth2 = (1-blend)*np.pi*(1+(1-hslope)*np.cos(2*np.pi*x2)) + blend*2*norm*(1+(y/xt)**alpha)
    sigma = r*r + spin*spin*np.cos(th)**2
    h = 2*r/sigma
    s = np.sin(th)**2

    def ks_vector(v):
        return (r*v[..., 0], dth1*v[..., 0]+dth2*v[..., 1], v[..., 2])

    def dot(v, w):
        return ((1+h)*v[0]*w[0] + sigma*v[1]*w[1] + s*(sigma+spin*spin*s*(1+h))*v[2]*w[2]
                - spin*s*(1+h)*(v[0]*w[2] + w[0]*v[2]))

    u, b = ks_vector(prims[..., 2:5]), ks_vector(prims[..., 5:8])
    bsq = (dot(b, b) + dot(u, b)**2) / ((1+h)*(1+dot(u, u)))
    weight = sigma * np.sin(th) * dth2
    def hemispheres(field):
        weighted = field * weight
        return np.stack([weighted[:, :4].sum(axis=1), weighted[:, 4:].sum(axis=1)], axis=-1)

    magnetic = hemispheres(bsq)
    thermal = hemispheres(prims[..., 1])
    # Normalize annuli to preserve the renderer's chosen radial luminosity.
    return .84*magnetic/magnetic.mean(axis=1, keepdims=True) + .16*thermal/thermal.mean(axis=1, keepdims=True)


def pack(source, output):
    frames = []
    for number in range(5400, 5432):
        with h5py.File(source / f'torus.out0.{number:05}.h5') as snap:
            grid = snap['header']
            if (snap['prims'].shape != (288, 128, 128, 8)
                    or abs(snap['t'][()] - number*5) >= .02
                    or abs(grid['geom/fmks/a'][()] - .5) > 1e-8
                    or abs(grid['dx1'][()] - .022244051549087665) > 1e-9
                    or abs(grid['startx1'][()] - .5014684328448891) > 1e-9):
                raise ValueError(f'Unexpected Illinois grid or epoch in dump {number}')
            frames.append(equatorial_activity(snap['prims'][:190, 60:68, :, :]))
    write_frames(frames, output)


def write_frames(frames, output):
    # Square-root companding preserves dark regions through eight-bit storage.
    power = np.minimum(frames, 9.)
    # Return the clipped tail's small luminosity budget to its own face and
    # annulus. At most nine times the mean survives finite-range storage.
    for _ in range(6):
        power = np.minimum(power / power.mean(axis=2, keepdims=True), 9.)
    encoded = np.rint(85 * np.sqrt(power)).astype(np.uint8)
    output.write_bytes(encoded.tobytes())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='directory containing 32 downloaded HDF5 snapshots')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    pack(args.source, args.output)
