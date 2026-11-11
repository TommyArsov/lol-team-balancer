# Scrim bot – Discord bot na LoL customky

Sebere lidi z hlasového kanálu, rozlosuje vyrovnané týmy a role, přesune je do kanálů týmů, po hře zapíše výsledek a vede rating a statistiky. Všechno ukazuje jako obrázky (losovací karta, výsledek zápasu, žebříček, profil s grafem, srovnání hráčů) a ovládá se tlačítky a menu přímo v Discordu.

## Příkazy

| Příkaz | Co dělá |
|---|---|
| `/scrim` | Vezme všechny z tvého hlasového kanálu a rozdělí je do vyrovnaných týmů podle ratingu. Nebo si týmy vyberete sami v menu pod kartou. Volby `tymy` (vyrovnané / náhodně) a `role` (podle preferencí / náhodně). |
| `/scrim modri:#kanál cerveni:#kanál` | Už jste rozdělení? Týmy zůstanou, bot rozdá jen role. Při nastavených `/kanaly` to pozná sám, stačí `/scrim` z jednoho z nich. |
| `/role` | Každý si nastaví role: Main / Jde to / Ne. |
| `/stats` | Žebříček. Menu na řazení (rating, winrate, KDA, zápasy, forma), stránkování, výběr hráče, graf. |
| `/profil` | Profil: rating a jeho graf, výhry a prohry, K/D/A, role, championi, nejlepší parťák a nemesis. Záložky Přehled / Zápasy / Spoluhráči. |
| `/vs hrac:@někdo` | Porovnání dvou hráčů: statistiky, kolik vyhráli spolu, jak to vychází proti sobě. |
| `/graf` | Vývoj ratingu, v menu se vybere až šest hráčů. |
| `/riot riot_id:Jméno#TAG` | Propojí Riot účet a načte rank. Kdo ještě nehrál, dostane z ranku výchozí rating. |
| `/zapas posledni` / `ukaz id:` | Seznam posledních zápasů, karta konkrétního zápasu. |
| `/zapas smazat id:` | Smaže zápas (správce). |
| `/hrac uzivatel: rating: aktivni:` | Ruční úprava výchozího ratingu, skrytí hráče (správce). |
| `/kanaly modri: cerveni: lobby:` | Nastaví hlasové kanály týmů a lobby (správce). |
| `/pomoc` | Krátký návod. |

### Jak probíhá večer

1. Sejdete se v lobby, někdo dá `/scrim`. Přijde karta s vyrovnanými týmy podle ratingu a odhadem šancí.
2. Týmy buď necháte, **Přelosujete**, nebo se rozdělíte sami: v menu **Rozdělíme se sami** vyberete modrý tým a zbytek jsou červení. Když už sedíte ve dvou hlasových kanálech, bot to pozná sám.
3. **Náhodné role / Role podle preferencí** přepíná, jak se rozdávají role. Bot si poslední volbu na serveru pamatuje.
4. **Rozházet do kanálů** přesune lidi, **Hrajeme** spustí zápas.
5. Po hře **Vyhráli modří / Vyhráli červení**. Karta se změní na výsledek se změnami ratingu a každý si přes **Moje statistiky** zapíše championa a K/D/A.
6. **Stejné týmy, nové role** je další hra série: týmy zůstanou, role se náhodně přelosují tak, aby nikdo nehrál to samé co minule. Na kartě je skóre série (např. 2 : 1).
7. **Nové týmy** znovu vyrovná týmy ze stejných lidí a začne novou sérii. **Všichni zpátky do lobby** přesune lidi zpátky.

Výsledek a statistiky může zapsat jen někdo, kdo v zápase hrál, nebo správce serveru (oprávnění Spravovat server). Noví lidé se přidají sami při prvním `/scrim`. Losování přežije restart bota.

## Založení bota (jednou, 5 minut)

1. Otevři <https://discord.com/developers/applications> → **New Application** → pojmenuj třeba Scrim.
2. Vlevo **Bot** → **Reset Token** → token zkopíruj do `.env` jako `DISCORD_TOKEN`. Nikomu ho neposílej.
3. Na stejné stránce vypni **Public Bot**, ať ho nemůže přidat nikdo jiný. Žádné „Privileged Gateway Intents“ zapínat nemusíš.
4. Spusť bota (viz níž). Do konzole vypíše pozvánku, otevři ji a přidej bota na svůj server.
5. Na serveru dej `/kanaly` a nastav kanály modrých, červených a lobby.
6. Zkontroluj, že bot má v těch kanálech oprávnění **Přesouvat členy** a **Připojit se** a v textovém kanálu **Přikládat soubory** (kvůli obrázkům). Pozvánka je chce, ale oprávnění kanálu je můžou přebít.

`DISCORD_GUILD_ID` doporučuju vyplnit, bot pak reaguje jen na vašem serveru. ID získáš po zapnutí Režimu vývojáře v nastavení Discordu: pravým na ikonu serveru → Kopírovat ID serveru.

## Spuštění

Potřebuješ Node 22.13 nebo novější (má vestavěné SQLite).

```bash
cp .env.example .env    # vyplň DISCORD_TOKEN a DISCORD_GUILD_ID
npm install
npm start
```

Nebo v Dockeru:

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f   # tady je pozvánka
```

Bot se k Discordu připojuje sám ven. Nepotřebuje veřejnou IP, otevřené porty, doménu ani HTTPS, stačí aby běžel nonstop. Běží na x64 i ARM64 (Raspberry Pi 4/5 s 64bit systémem), RAM si vezme kolem 100 MB.

## Kde to provozovat zdarma

- **Raspberry Pi nebo jiný počítač doma.** Nejjednodušší a nic nevyprší. Stačí Docker a `docker compose up -d`.
- **Oracle Cloud Always Free.** ARM VM (od června 2026 až 2 jádra a 12 GB RAM) je pro bota víc než dost. Pozor: Oracle si může vzít zpátky instanci, která je týden skoro nečinná (pod 20 % CPU, sítě i paměti), a bot je skoro pořád nečinný. Počítej s tím, nebo měj zálohy databáze.

## Riot API

Klíč z <https://developer.riotgames.com> dej do `RIOT_API_KEY`, `RIOT_PLATFORM` nastav na `eun1` (EUNE) nebo `euw1` (EUW). Development klíč vyprší po 24 hodinách, na trvalý provoz si zažádej o Personal API key. Bez klíče `/riot` jen uloží Riot ID.

Riot API nevrací custom hry, proto se champion a K/D/A zapisují ručně přes Moje statistiky. Ikony championů bot stahuje z Data Dragonu a ukládá do `data/cache`.

## Jak funguje losování

- **Vyrovnané týmy** projdou všech 126 rozdělení 10 hráčů. Pro každé najdou nejlepší rozdělení rolí a spočítají skóre: rozdíl průměrného ratingu, penalizaci za role mimo preference a malou penalizaci za dvojice, které spolu hrály v posledních dvou zápasech (ať se týmy střídají). Pak náhodně vyberou jednu ze sestav blízkých optimu, takže Přelosovat dává pokaždé něco jiného.
- **Úplně náhodně** týmy jen zamíchá.
- Víc než 10 lidí: přebyteční jdou náhodně na lavičku, stejně tak při lichém počtu. Funguje i 2v2 až 4v4.
- Šance na výhru je Elo odhad z průměrného ratingu týmů.

## Rating

Každý začíná na 1000 (zhruba Silver IV), nebo na hodnotě z ranku přes `/riot`. Po každém zápase se změní Elo vzorcem podle síly obou týmů (`ELO_K`, výchozí 32). Prvních 5 zápasů se mění o polovinu rychleji, aby se nováček rychle usadil (na kartě je označený jako nováček). Rating se vždy přepočítá od začátku, takže oprava nebo smazání starého zápasu se správně promítne.

Hraním víc her se rating sám nezvedá: co jeden tým získá, druhý ztratí, a kdo je slabší, s více hrami spíš klesá. Ověřeno simulací (14 hráčů, různá docházka, 200 běhů): mezi počtem her a nadhodnocením ratingu není žádná souvislost. Nepřesný je naopak rating lidí s málo hrami, protože se ještě nestihl pohnout od startu. Proto mají hráči pod `MIN_GAMES_RANKED` her (výchozí 10) v žebříčku pomlčku místo pořadí a jsou ztlumení pod ostatními.

## Záloha

Všechno je v jednom souboru `data/scrim.db` (v Dockeru ve volume `scrim-data`):

```bash
docker compose cp scrim-bot:/data/scrim.db ./zaloha-$(date +%F).db
```

## Soubory

- `index.js` – spuštění a konfigurace
- `bot.js` – příkazy, tlačítka, menu, zprávy
- `render.js` – obrázky (SVG → PNG přes resvg)
- `db.js` – databáze, rating, statistiky, Riot API
- `roll.js` – losovací algoritmus
- `fonts/` – Barlow a Barlow Condensed (SIL Open Font License)

---

Scrim bot isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
