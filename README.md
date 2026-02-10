# Crank

The vault's hands. Settles options past expiry, writes fresh ones against free
stock, folds arrived premiums into the per-share total. It decides nothing about
price: premiums are computed on chain when a buyer pays, so a wrong number here
buys nobody anything.

```
CRANK_KEY=0x...   the vault's keeper key
VAULTS=0xc79Aa3ac7Ef7905608fF42153768CAE194D2092B,0x379203E346E66ddFB2c69208699904846aa2553F,0xf04a8f4D8D390d665E8D0d345A2D6d59913CB581,0x0c2bcFcC8A732B113d5f9EB21D62dFF6Cb688180,0x3920B885217b43f1D34e8b50b33e931c0affaC90,0xC733DC6fE301B8a1B985bC0f355B0F32C690B213,0x74B7bd959E11b3086A5BF3B1E4332db27a31568b,0x0C7287cC20d0F353b389D9A88Bb8944bC4B53Cb4,0x917265B4DbA07ef1F910F7fab4BFA4B6de3A995a,0xE43f603b67DCB25b4Fa47B04DB15e44f9165fa51,0x7699a03c49b1Fe11Ceff1DDe653aDbBEe687C91b,0x089B8B8bC4b8f3C1015E7d90fFEB47a7916EcC04,0x8c4E83bE143fD809E39f547182f1680EA7112bdd,0xfB0030C21297f5E469de53975f32951650Efc7e0,0x2db893D23b8Aba629EB02da234902C6670F92d47,0x059938c5f044f2ab5d3090c8e21b20b84BF36F25,0x4E7f659537556989E811035fb0417f7E33096595
STRIKE_BPS=11000  strike at 110% of spot
TENOR_DAYS=7
INTERVAL_SEC=3600
DRY_RUN=1         decide and print, never send
```

```
npm install
DRY_RUN=1 npm run once      # one pass, nothing sent
npm start                   # the loop
```

The key can do two things, write and settle, and both move assets only between
the vault and the house. A stolen crank key can write badly-struck options; it
cannot take a share.
