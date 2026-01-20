# saturn2022-crank

Keeper server for [saturn2022](https://saturn2022.com) vaults. Writes
covered calls against free stock, settles what expired, folds premiums into
the running total. Holds no custody; every path moves assets between the vault
and the house.

```
npm install
npm start
```

Read [crank.mjs](crank.mjs) before running it.
