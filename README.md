# 💘 Secret Crush

A tiny office game: colleagues name their crush(es), and the most crushed-on person wins a prize.

- **Fully anonymous:** only per-name totals are stored. There is no record of who picked whom, not even for the admin.
- The leaderboard stays hidden until the admin reveals it.
- One vote per person, up to 3 crushes, and you can't vote for yourself.
- Zero dependencies: plain Node.js (18+).

## Run

```bash
npm start
```

Open `http://localhost:3000`. Colleagues on the same network use `http://<your-ip>:3000`.
The admin panel is at `/admin`. Its key is printed in the console when the server starts.

## Options

| Env var       | Default        | Meaning                        |
|---------------|----------------|--------------------------------|
| `PORT`        | `3000`         | Port to listen on              |
| `ADMIN_KEY`   | auto-generated | Key for the admin panel        |
| `MAX_CRUSHES` | `3`            | Max crushes per voter          |

**Roster (optional):** copy `roster.example.txt` to `roster.txt` with one colleague per line. Names then autocomplete, and only names on the list are accepted.

Data is stored in `data/db.json`. It is git-ignored, so keep it private.
