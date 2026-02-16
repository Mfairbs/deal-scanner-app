import { useState, useMemo, useCallback, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import * as Papa from "papaparse";

// --- SCORING CONFIG ---
const DISTRESS_KEYWORDS = [
  "mortgagee","receivership","must sell","reduced","all offers considered",
  "vacant possession","liquidation","administration","urgent","below valuation",
  "motivated vendor","deadline","court ordered","bank instructed","priced to sell",
  "price drop","fire sale","distressed","under instructions","expressions of interest"
];

const COLUMN_ALIASES = {
  address: ["address","street address","street_address","property address","full address"],
  suburb: ["suburb","location","area"],
  state: ["state"],
  postcode: ["postcode","post code","zip","postal code"],
  propertyType: ["property type","property_type","type","category"],
  askingPrice: ["asking price","asking_price","price","list price","last listed price","first listed price","listed price","sale price"],
  landArea: ["land area","land_area","land size","land size (m²)","land_size","land sqm","land (sqm)"],
  buildingArea: ["building area","building_area","floor size","floor size (m²)","floor_size","building sqm","building (sqm)"],
  daysOnMarket: ["days on market","days_on_market","dom","days listed","days"],
  agentName: ["agent name","agent_name","agent","listing agent"],
  agency: ["agency","agency name","office"],
  listingUrl: ["listing url","listing_url","url","link","open in rpdata","listing link"],
  description: ["description","listing description","details","comments","notes"],
  councilArea: ["council area","council","lga"],
  listingType: ["listing type","listing_type","sale method"],
};

function normalise(s) { return (s || "").toString().toLowerCase().trim().replace(/[_\-]/g," "); }

function autoMapColumns(headers) {
  const map = {};
  const normHeaders = headers.map(normalise);
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = normHeaders.indexOf(normalise(alias));
      if (idx !== -1 && !Object.values(map).includes(headers[idx])) {
        map[field] = headers[idx];
        break;
      }
    }
  }
  return map;
}

function parsePrice(raw) {
  if (!raw) return null;
  const s = raw.toString().trim();
  const skip = /contact agent|poa|expressions? of interest|price on application|price on request|undisclosed|by negotiation|for sale|just listed|under contract|listing price not available|auction|submit all offers/i;
  if (skip.test(s)) return null;
  const rangeMatch = s.match(/\$\s*([\d,.]+)\s*([mkMK])?\s*[-–]\s*\$\s*([\d,.]+)\s*([mkMK])?/);
  if (rangeMatch) {
    const lo = toNum(rangeMatch[1], rangeMatch[2]);
    const hi = toNum(rangeMatch[3], rangeMatch[4]);
    if (lo !== null && hi !== null) return Math.round((lo + hi) / 2);
    return lo || hi;
  }
  const single = s.match(/\$\s*([\d,.]+)\s*([mkMK])?/);
  if (single) return toNum(single[1], single[2]);
  const plain = s.replace(/[,$\s]/g, "");
  if (/^\d+(\.\d+)?$/.test(plain)) return Math.round(parseFloat(plain));
  return null;
}
function toNum(digits, suffix) {
  const n = parseFloat(digits.replace(/,/g, ""));
  if (isNaN(n)) return null;
  if (suffix && suffix.toLowerCase() === "m") return Math.round(n * 1_000_000);
  if (suffix && suffix.toLowerCase() === "k") return Math.round(n * 1_000);
  return Math.round(n);
}

function scoreProperty(row) {
  const desc = (row.description || "").toLowerCase();
  const foundKeywords = DISTRESS_KEYWORDS.filter(kw => desc.includes(kw));
  const kwCount = foundKeywords.length;
  let distressScore = 0;
  if (kwCount >= 4) distressScore = 50;
  else if (kwCount === 3) distressScore = 40;
  else if (kwCount === 2) distressScore = 30;
  else if (kwCount === 1) distressScore = 15;

  const dom = row.daysOnMarket;
  let domScore = 5;
  if (dom !== null && dom !== undefined && dom !== "") {
    const d = parseInt(dom);
    if (!isNaN(d)) {
      if (d > 180) domScore = 30;
      else if (d >= 121) domScore = 20;
      else if (d >= 61) domScore = 10;
      else domScore = 0;
    }
  }

  let vacancyScore = 0;
  if (desc.includes("vacant possession")) vacancyScore = 20;
  else if (!/(leased|tenant|lease|tenancy|net income)/i.test(desc)) vacancyScore = 10;

  const total = distressScore + domScore + vacancyScore;
  let priority = "Low";
  if (total >= 60) priority = "High Priority";
  else if (total >= 35) priority = "Monitor";

  return { score: total, priority, distressKeywords: foundKeywords, distressScore, domScore, vacancyScore };
}

function formatAUD(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

const PRIORITY_COLORS = { "High Priority": "#DC2626", "Monitor": "#D97706", "Low": "#9CA3AF" };
const PRIORITY_BG = { "High Priority": "#FEE2E2", "Monitor": "#FEF3C7", "Low": "#F3F4F6" };

// --- MAIN COMPONENT ---
export default function DealScanner() {
  const [rawData, setRawData] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [colMap, setColMap] = useState({});
  const [showMapping, setShowMapping] = useState(false);
  const [properties, setProperties] = useState([]);
  const [activeTab, setActiveTab] = useState("table");
  const [expandedRow, setExpandedRow] = useState(null);
  const [sortCol, setSortCol] = useState("score");
  const [sortDir, setSortDir] = useState("desc");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({
    priority: ["High Priority", "Monitor", "Low"],
    propertyType: [],
    suburbs: [],
    priceMin: 0, priceMax: 999_999_999,
    scoreMin: 0,
    domMin: 0, domMax: 9999,
  });
  const fileRef = useRef();

  const processData = useCallback((data, mapping) => {
    const rows = data.map(row => {
      const get = (field) => {
        const col = mapping[field];
        return col ? (row[col] ?? "") : "";
      };
      const price = parsePrice(get("askingPrice"));
      const dom = get("daysOnMarket");
      const domNum = dom !== "" && dom !== "-" ? parseInt(dom) : null;
      const mapped = {
        address: get("address"),
        suburb: get("suburb"),
        state: get("state") || "NSW",
        postcode: get("postcode"),
        propertyType: get("propertyType"),
        askingPriceRaw: get("askingPrice"),
        askingPrice: price,
        landArea: get("landArea") !== "-" ? get("landArea") : "",
        buildingArea: get("buildingArea") !== "-" ? get("buildingArea") : "",
        daysOnMarket: domNum,
        agentName: get("agentName"),
        agency: get("agency"),
        listingUrl: get("listingUrl"),
        description: get("description"),
        councilArea: get("councilArea"),
        listingType: get("listingType"),
      };
      const scoring = scoreProperty(mapped);
      return { ...mapped, ...scoring };
    });
    setProperties(rows);
  }, []);

  const handleFile = (file) => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "csv" || ext === "tsv") {
      Papa.parse(file, {
        header: true, skipEmptyLines: true, complete: (result) => {
          const h = result.meta.fields || [];
          setHeaders(h);
          setRawData(result.data);
          const map = autoMapColumns(h);
          setColMap(map);
          const mapped = Object.keys(map).length;
          if (mapped < 3) { setShowMapping(true); }
          else { processData(result.data, map); setShowMapping(false); }
        }
      });
    } else {
      alert("Please upload a CSV file. You can export from Excel using Save As > CSV.");
    }
  };

  const applyMapping = () => {
    processData(rawData, colMap);
    setShowMapping(false);
  };

  const allSuburbs = useMemo(() => [...new Set(properties.map(p => p.suburb).filter(Boolean))].sort(), [properties]);
  const allTypes = useMemo(() => [...new Set(properties.map(p => p.propertyType).filter(Boolean))].sort(), [properties]);

  const filtered = useMemo(() => {
    let list = properties;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        (p.address || "").toLowerCase().includes(q) ||
        (p.suburb || "").toLowerCase().includes(q) ||
        (p.propertyType || "").toLowerCase().includes(q) ||
        (p.description || "").toLowerCase().includes(q)
      );
    }
    list = list.filter(p => filters.priority.includes(p.priority));
    if (filters.propertyType.length > 0) list = list.filter(p => filters.propertyType.includes(p.propertyType));
    if (filters.suburbs.length > 0) list = list.filter(p => filters.suburbs.includes(p.suburb));
    list = list.filter(p => (p.askingPrice === null || (p.askingPrice >= filters.priceMin && p.askingPrice <= filters.priceMax)));
    list = list.filter(p => p.score >= filters.scoreMin);
    list = list.filter(p => {
      const d = p.daysOnMarket ?? 0;
      return d >= filters.domMin && d <= filters.domMax;
    });
    list.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (va === null || va === undefined) va = sortDir === "asc" ? Infinity : -Infinity;
      if (vb === null || vb === undefined) vb = sortDir === "asc" ? Infinity : -Infinity;
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return list;
  }, [properties, search, filters, sortCol, sortDir]);

  const stats = useMemo(() => {
    if (!properties.length) return null;
    const high = properties.filter(p => p.priority === "High Priority").length;
    const monitor = properties.filter(p => p.priority === "Monitor").length;
    const low = properties.filter(p => p.priority === "Low").length;
    const avgScore = (properties.reduce((s, p) => s + p.score, 0) / properties.length).toFixed(1);
    const withDom = properties.filter(p => p.daysOnMarket !== null);
    const avgDom = withDom.length ? (withDom.reduce((s, p) => s + p.daysOnMarket, 0) / withDom.length).toFixed(0) : "—";
    return { total: properties.length, high, monitor, low, avgScore, avgDom };
  }, [properties]);

  const keywordFreq = useMemo(() => {
    const freq = {};
    DISTRESS_KEYWORDS.forEach(kw => freq[kw] = 0);
    properties.forEach(p => p.distressKeywords.forEach(kw => freq[kw]++));
    return Object.entries(freq).map(([k, v]) => ({ keyword: k, count: v })).filter(d => d.count > 0).sort((a, b) => b.count - a.count);
  }, [properties]);

  const exportCSV = () => {
    const rows = filtered.map(p => ({
      Address: p.address, Suburb: p.suburb, State: p.state, Postcode: p.postcode,
      "Property Type": p.propertyType, "Asking Price (AUD)": p.askingPrice || "",
      "Price Text": p.askingPriceRaw, "Land Area (sqm)": p.landArea, "Building Area (sqm)": p.buildingArea,
      "Days on Market": p.daysOnMarket ?? "", "Agent": p.agentName, Agency: p.agency,
      "Listing URL": p.listingUrl, Score: p.score, Priority: p.priority,
      "Distress Signals": p.distressKeywords.join("; "),
      "Distress Score": p.distressScore, "DOM Score": p.domScore, "Vacancy Score": p.vacancyScore,
      Description: p.description,
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `scored_properties_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const SortIcon = ({ col }) => {
    if (sortCol !== col) return <span className="text-gray-300 ml-1">↕</span>;
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  // --- UPLOAD SCREEN ---
  if (!properties.length && !showMapping) {
    return (
      <div className="min-h-screen bg-white p-4 md:p-8 font-sans">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">NSW Commercial Property Deal Scanner</h1>
        <p className="text-gray-500 mb-8 text-sm">Upload property listings to score and identify distressed opportunities.</p>
        <div
          onClick={() => fileRef.current?.click()}
          onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
          onDragOver={e => e.preventDefault()}
          className="border-2 border-dashed border-gray-300 rounded-lg p-16 text-center cursor-pointer hover:border-gray-400 transition-colors max-w-xl mx-auto"
        >
          <div className="text-4xl mb-4 text-gray-400">+</div>
          <p className="text-gray-600 font-medium">Drop CSV file here or click to upload</p>
          <p className="text-gray-400 text-sm mt-2">Accepts .csv files exported from CommercialRealEstate.com.au or similar</p>
          <input ref={fileRef} type="file" accept=".csv,.tsv" className="hidden" onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
        </div>
      </div>
    );
  }

  // --- MAPPING SCREEN ---
  if (showMapping) {
    const fields = Object.keys(COLUMN_ALIASES);
    return (
      <div className="min-h-screen bg-white p-4 md:p-8 font-sans">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Column Mapping</h1>
        <p className="text-gray-500 mb-6 text-sm">Some columns couldn't be matched automatically. Please map them below.</p>
        <div className="max-w-2xl space-y-3">
          {fields.map(field => (
            <div key={field} className="flex items-center gap-4">
              <label className="w-40 text-sm font-medium text-gray-700 capitalize">{field.replace(/([A-Z])/g, " $1")}</label>
              <select
                className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm"
                value={colMap[field] || ""}
                onChange={e => setColMap(m => ({ ...m, [field]: e.target.value || undefined }))}
              >
                <option value="">— Not mapped —</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          ))}
        </div>
        <button onClick={applyMapping} className="mt-6 px-6 py-2 bg-gray-900 text-white rounded text-sm font-medium hover:bg-gray-800">Apply & Score</button>
      </div>
    );
  }

  // --- MAIN DASHBOARD ---
  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 md:px-8 py-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">NSW Commercial Deal Scanner</h1>
            <p className="text-xs text-gray-400">{stats.total} properties scored | {new Date().toLocaleDateString("en-AU")}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => { setProperties([]); setRawData(null); setHeaders([]); setShowMapping(false); }}
              className="px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-600 hover:bg-gray-50">New Upload</button>
            <button onClick={exportCSV} className="px-3 py-1.5 bg-gray-900 text-white rounded text-sm font-medium hover:bg-gray-800">Export CSV</button>
          </div>
        </div>
      </div>

      {/* Summary Bar */}
      <div className="px-4 md:px-8 py-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Total Properties", value: stats.total, color: "text-gray-900" },
            { label: "High Priority", value: stats.high, color: "text-red-600" },
            { label: "Monitor", value: stats.monitor, color: "text-amber-600" },
            { label: "Low", value: stats.low, color: "text-gray-400" },
            { label: "Avg Score / Avg DOM", value: `${stats.avgScore} / ${stats.avgDom}d`, color: "text-gray-900" },
          ].map((s, i) => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-3">
              <div className="text-xs text-gray-500 mb-1">{s.label}</div>
              <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 md:px-8">
        <div className="flex gap-1 border-b border-gray-200">
          {["table", "distress"].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === tab ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              {tab === "table" ? "Properties" : "Distress Signals"}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 md:px-8 py-4">
        {activeTab === "distress" ? (
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Distress Keyword Frequency</h2>
            <p className="text-xs text-gray-500 mb-4">Across all {stats.total} properties</p>
            {keywordFreq.length === 0 ? (
              <p className="text-gray-400 text-sm py-8 text-center">No distress keywords found in descriptions. Your data may not include a description column.</p>
            ) : (
              <div style={{ width: "100%", height: Math.max(300, keywordFreq.length * 32) }}>
                <ResponsiveContainer>
                  <BarChart data={keywordFreq} layout="vertical" margin={{ left: 140, right: 20, top: 5, bottom: 5 }}>
                    <XAxis type="number" tick={{ fontSize: 12 }} />
                    <YAxis type="category" dataKey="keyword" tick={{ fontSize: 12 }} width={130} />
                    <Tooltip />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {keywordFreq.map((_, i) => <Cell key={i} fill={i < 3 ? "#DC2626" : i < 8 ? "#D97706" : "#6B7280"} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col lg:flex-row gap-4">
            {/* Filters Panel */}
            <div className="lg:w-64 flex-shrink-0">
              <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
                <h3 className="text-sm font-bold text-gray-900">Filters</h3>

                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">Search</label>
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Address, suburb, keyword..."
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">Priority</label>
                  {["High Priority", "Monitor", "Low"].map(p => (
                    <label key={p} className="flex items-center gap-2 text-sm py-0.5">
                      <input type="checkbox" checked={filters.priority.includes(p)}
                        onChange={e => setFilters(f => ({
                          ...f, priority: e.target.checked ? [...f.priority, p] : f.priority.filter(x => x !== p)
                        }))} />
                      <span style={{ color: PRIORITY_COLORS[p] }}>{p}</span>
                    </label>
                  ))}
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">Property Type</label>
                  <select multiple className="w-full border border-gray-300 rounded px-2 py-1 text-xs h-24"
                    value={filters.propertyType}
                    onChange={e => setFilters(f => ({ ...f, propertyType: [...e.target.selectedOptions].map(o => o.value) }))}>
                    {allTypes.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <p className="text-xs text-gray-400 mt-0.5">Cmd/Ctrl+click to multi-select. Empty = all.</p>
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">Suburb</label>
                  <select multiple className="w-full border border-gray-300 rounded px-2 py-1 text-xs h-24"
                    value={filters.suburbs}
                    onChange={e => setFilters(f => ({ ...f, suburbs: [...e.target.selectedOptions].map(o => o.value) }))}>
                    {allSuburbs.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <p className="text-xs text-gray-400 mt-0.5">Empty = all suburbs.</p>
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">Min Score: {filters.scoreMin}</label>
                  <input type="range" min={0} max={100} value={filters.scoreMin}
                    onChange={e => setFilters(f => ({ ...f, scoreMin: +e.target.value }))} className="w-full" />
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">DOM Range: {filters.domMin}–{filters.domMax}</label>
                  <div className="flex gap-2">
                    <input type="number" min={0} value={filters.domMin} placeholder="Min"
                      onChange={e => setFilters(f => ({ ...f, domMin: +e.target.value || 0 }))}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                    <input type="number" min={0} value={filters.domMax} placeholder="Max"
                      onChange={e => setFilters(f => ({ ...f, domMax: +e.target.value || 9999 }))}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                  </div>
                </div>

                <button onClick={() => setFilters({
                  priority: ["High Priority", "Monitor", "Low"], propertyType: [], suburbs: [],
                  priceMin: 0, priceMax: 999_999_999, scoreMin: 0, domMin: 0, domMax: 9999,
                })} className="w-full text-xs text-gray-500 hover:text-gray-700 py-1">Reset Filters</button>
              </div>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-x-auto">
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="px-4 py-3 border-b border-gray-100 flex justify-between items-center">
                  <span className="text-sm text-gray-500">{filtered.length} of {properties.length} properties</span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      {[
                        { key: "address", label: "Address" },
                        { key: "suburb", label: "Suburb" },
                        { key: "propertyType", label: "Type" },
                        { key: "askingPrice", label: "Price (AUD)" },
                        { key: "daysOnMarket", label: "DOM" },
                        { key: "score", label: "Score" },
                        { key: "priority", label: "Priority" },
                      ].map(col => (
                        <th key={col.key} onClick={() => toggleSort(col.key)}
                          className="px-3 py-2 text-left text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 whitespace-nowrap">
                          {col.label}<SortIcon col={col.key} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 200).map((p, i) => (
                      <>
                        <tr key={i} onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                          className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${expandedRow === i ? "bg-gray-50" : ""}`}>
                          <td className="px-3 py-2 font-medium text-gray-900 max-w-xs truncate">{p.address || "—"}</td>
                          <td className="px-3 py-2 text-gray-600">{p.suburb || "—"}</td>
                          <td className="px-3 py-2 text-gray-600 max-w-[140px] truncate">{p.propertyType || "—"}</td>
                          <td className="px-3 py-2 text-gray-900 font-medium">{p.askingPrice ? formatAUD(p.askingPrice) : (p.askingPriceRaw || "—")}</td>
                          <td className="px-3 py-2 text-gray-600">{p.daysOnMarket ?? "—"}</td>
                          <td className="px-3 py-2">
                            <span className="font-bold" style={{ color: PRIORITY_COLORS[p.priority] }}>{p.score}</span>
                          </td>
                          <td className="px-3 py-2">
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium"
                              style={{ backgroundColor: PRIORITY_BG[p.priority], color: PRIORITY_COLORS[p.priority] }}>
                              {p.priority}
                            </span>
                          </td>
                        </tr>
                        {expandedRow === i && (
                          <tr key={`exp-${i}`} className="bg-gray-50 border-b border-gray-200">
                            <td colSpan={7} className="px-4 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                <div>
                                  <h4 className="font-bold text-gray-900 mb-2">Score Breakdown</h4>
                                  <div className="space-y-1 text-xs">
                                    <div className="flex justify-between"><span className="text-gray-500">Distress Keywords</span><span className="font-medium">{p.distressScore}/50</span></div>
                                    <div className="flex justify-between"><span className="text-gray-500">Days on Market</span><span className="font-medium">{p.domScore}/30</span></div>
                                    <div className="flex justify-between"><span className="text-gray-500">Vacancy Signal</span><span className="font-medium">{p.vacancyScore}/20</span></div>
                                    <div className="flex justify-between border-t border-gray-200 pt-1 mt-1"><span className="text-gray-900 font-bold">Total</span><span className="font-bold">{p.score}/100</span></div>
                                  </div>
                                  {p.distressKeywords.length > 0 && (
                                    <div className="mt-3">
                                      <span className="text-xs text-gray-500 block mb-1">Keywords found:</span>
                                      <div className="flex flex-wrap gap-1">
                                        {p.distressKeywords.map(kw => (
                                          <span key={kw} className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs">{kw}</span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <h4 className="font-bold text-gray-900 mb-2">Details</h4>
                                  <div className="space-y-1 text-xs">
                                    <div><span className="text-gray-500">Agent:</span> {p.agentName || "—"} {p.agency ? `(${p.agency})` : ""}</div>
                                    <div><span className="text-gray-500">Land:</span> {p.landArea || "—"} sqm | <span className="text-gray-500">Building:</span> {p.buildingArea || "—"} sqm</div>
                                    <div><span className="text-gray-500">Price Text:</span> {p.askingPriceRaw || "—"}</div>
                                    <div><span className="text-gray-500">Council:</span> {p.councilArea || "—"}</div>
                                    {p.listingUrl && (
                                      <a href={p.listingUrl} target="_blank" rel="noopener noreferrer"
                                        className="text-blue-600 hover:underline inline-block mt-1">View Listing →</a>
                                    )}
                                  </div>
                                  {p.description && (
                                    <div className="mt-3">
                                      <span className="text-xs text-gray-500 block mb-1">Description:</span>
                                      <p className="text-xs text-gray-600 max-h-32 overflow-y-auto leading-relaxed">{p.description}</p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
                {filtered.length > 200 && (
                  <div className="px-4 py-3 text-center text-xs text-gray-400 border-t border-gray-100">
                    Showing first 200 of {filtered.length} results. Use filters to narrow down.
                  </div>
                )}
                {filtered.length === 0 && (
                  <div className="px-4 py-12 text-center text-sm text-gray-400">No properties match your filters.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}