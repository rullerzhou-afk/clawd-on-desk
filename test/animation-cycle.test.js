"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CYCLE_STATUS,
  probeAssetCycle,
  probeSvgCycle,
  probeGifCycle,
  probeApngCycle,
} = require("../src/animation-cycle");

function buildGifFrame(delayCs) {
  return Buffer.from([
    0x21, 0xf9, 0x04, 0x00,
    delayCs & 0xff, (delayCs >> 8) & 0xff,
    0x00, 0x00,
    0x2c,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00,
    0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
  ]);
}

function buildGifBuffer(delaysCs) {
  const header = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00,
    0x80, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0xff, 0xff, 0xff,
  ]);
  const frames = delaysCs.map((delayCs) => buildGifFrame(delayCs));
  return Buffer.concat([header, ...frames, Buffer.from([0x3b])]);
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  data.copy(out, 8);
  return out;
}

function buildApngBuffer(frameDelays) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frameDelays.length, 0);
  actl.writeUInt32BE(0, 4);

  const chunks = [
    pngChunk("IHDR", ihdr),
    pngChunk("acTL", actl),
  ];

  for (let i = 0; i < frameDelays.length; i++) {
    const { num, den } = frameDelays[i];
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(i, 0);
    fctl.writeUInt32BE(1, 4);
    fctl.writeUInt32BE(1, 8);
    fctl.writeUInt32BE(0, 12);
    fctl.writeUInt32BE(0, 16);
    fctl.writeUInt16BE(num, 20);
    fctl.writeUInt16BE(den, 22);
    chunks.push(pngChunk("fcTL", fctl));
    if (i === 0) {
      chunks.push(pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])));
    } else {
      const fdat = Buffer.alloc(4);
      fdat.writeUInt32BE(i, 0);
      chunks.push(pngChunk("fdAT", fdat));
    }
  }

  chunks.push(pngChunk("IEND"));
  return Buffer.concat([signature, ...chunks]);
}

describe("animation-cycle SVG probe", () => {
  it("reads a single CSS loop duration exactly", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.body { animation: bounce 1.5s infinite ease-in-out; }</style>
        <g class="body"></g>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 1500,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("computes the full repeat cycle for multiple looping animations", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          .a { animation: bounce 1s infinite linear; }
          .b { animation: blink 1.5s infinite linear; }
        </style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 3000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("treats mixed finite and looping timelines as estimated fallback", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          .looping { animation: spin 1s infinite linear; }
          .oneshot { animation: pulse 2.5s 1 ease-out; }
        </style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 2500,
      status: CYCLE_STATUS.ESTIMATED,
      source: "svg",
    });
  });

  it("accounts for alternate CSS loops returning to the starting pose", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.arm { animation: wave 150ms infinite alternate ease-in-out; }</style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 300,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("reads finite duration probes from CDATA style blocks", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style><![CDATA[
          .duration-probe {
            animation: mini-enter-duration-probe 1.25s linear 1 both;
          }
        ]]></style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 1250,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });
});

describe("animation-cycle raster probes", () => {
  it("sums GIF frame delays", () => {
    const gif = buildGifBuffer([20, 50]);
    assert.deepStrictEqual(probeGifCycle(gif), {
      ms: 700,
      status: CYCLE_STATUS.EXACT,
      source: "gif",
    });
  });

  it("sums APNG frame delays", () => {
    const apng = buildApngBuffer([{ num: 10, den: 10 }, { num: 15, den: 10 }]);
    assert.deepStrictEqual(probeApngCycle(apng), {
      ms: 2500,
      status: CYCLE_STATUS.EXACT,
      source: "apng",
    });
  });

  it("sums fractional APNG delays before rounding", () => {
    const apng = buildApngBuffer(Array.from({ length: 12 }, () => ({ num: 1, den: 12 })));
    assert.deepStrictEqual(probeApngCycle(apng), {
      ms: 1000,
      status: CYCLE_STATUS.EXACT,
      source: "apng",
    });
  });
});

describe("probeAssetCycle", () => {
  it("dispatches by extension, marks static rasters, and returns unavailable for unsupported files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anim-cycle-"));
    const svgPath = path.join(tempDir, "loop.svg");
    const gifPath = path.join(tempDir, "loop.gif");
    const pngPath = path.join(tempDir, "still.png");
    const webpPath = path.join(tempDir, "still.webp");
    const jpgPath = path.join(tempDir, "still.jpg");
    const jpegPath = path.join(tempDir, "still.jpeg");
    const txtPath = path.join(tempDir, "readme.txt");

    fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg"><style>.x { animation: blink 2s infinite linear; }</style></svg>`, "utf8");
    fs.writeFileSync(gifPath, buildGifBuffer([12]));
    fs.writeFileSync(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));
    fs.writeFileSync(webpPath, Buffer.from("524946460000000057454250", "hex"));
    fs.writeFileSync(jpgPath, Buffer.from("ffd8ffe000104a4649460001", "hex"));
    fs.writeFileSync(jpegPath, Buffer.from("ffd8ffe000104a4649460001", "hex"));
    fs.writeFileSync(txtPath, "plain text", "utf8");

    assert.deepStrictEqual(probeAssetCycle(svgPath), {
      ms: 2000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
    assert.deepStrictEqual(probeAssetCycle(gifPath), {
      ms: 120,
      status: CYCLE_STATUS.EXACT,
      source: "gif",
    });
    assert.deepStrictEqual(probeAssetCycle(pngPath), {
      ms: null,
      status: CYCLE_STATUS.STATIC,
      source: "png",
    });
    assert.deepStrictEqual(probeAssetCycle(webpPath), {
      ms: null,
      status: CYCLE_STATUS.STATIC,
      source: "webp",
    });
    assert.deepStrictEqual(probeAssetCycle(jpgPath), {
      ms: null,
      status: CYCLE_STATUS.STATIC,
      source: "jpg",
    });
    assert.deepStrictEqual(probeAssetCycle(jpegPath), {
      ms: null,
      status: CYCLE_STATUS.STATIC,
      source: "jpeg",
    });
    assert.deepStrictEqual(probeAssetCycle(txtPath), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "txt",
    });
  });
});
