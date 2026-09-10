# Using the alias with an existing dependency tree

```sh
npm install better-sqlite3@npm:better-sqlite3-compat
```

After this, `require('better-sqlite3')` and `import Database from 'better-sqlite3'` resolve to the compat layer everywhere in the project, including inside dependencies such as Knex's `better-sqlite3` client. Remove the alias and reinstall to switch back.
