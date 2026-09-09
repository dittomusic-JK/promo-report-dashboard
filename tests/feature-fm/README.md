# Feature.fm fixture

`fixture.html` is a static copy of the layout of a Feature.fm shared analytics page (Timeline, Channels, Referrals, Clicks to Service, Countries), with hover tooltips on the chart.

The live import in `server.js` now reads the console's public JSON API directly (`console-api.feature.fm/v2/smartlink-shared-analytics/<uuid>?entry=…&start=&end=`), so this fixture is kept as reference for the page structure should DOM parsing ever be needed again.
