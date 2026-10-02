import re, datetime, json

html = open(r"_research/raw/news_list.html", encoding="utf-8").read()
pat = re.compile(r'\\"cid\\":\\"(\d+)\\",\\"tab\\":\\"(\d+)\\"[^}]*?\\"title\\":\\"(.*?)\\",\\"author\\":\\"(.*?)\\",\\"displayTime\\":(\d+)')
seen = {}
for cid, tab, title, author, ts in pat.findall(html):
    seen[cid] = (int(ts), tab, title, author)

tz = datetime.timezone(datetime.timedelta(hours=8))
s9 = int(datetime.datetime(2026, 9, 1, tzinfo=tz).timestamp())
e11 = int(datetime.datetime(2026, 11, 1, tzinfo=tz).timestamp())
hit = sorted([v + (c,) for c, v in seen.items() if s9 <= v[0] < e11])
print("去重后公告总数:", len(seen), "| 9-10月:", len(hit))
for ts, tab, title, author, cid in hit:
    print(datetime.datetime.fromtimestamp(ts, tz).strftime("%m-%d"), "tab" + tab, title)
