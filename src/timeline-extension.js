// Extension GPU du voyage dans le temps.
// Chaque bâtiment porte [annéeDébut, annéeFin, période] :
//   année < début            : absent
//   début <= année < fin     : « possible » (période en cours), dessiné en fantôme
//   année >= fin             : attesté ; s'il est daté à l'année près, il s'élève
//                              pendant l'année qui précède et brille quelques années.
// La mise en exergue d'une période grise les autres, par un mélange animé.
import {LayerExtension} from '@deck.gl/core';

const uniformBlock = /* glsl */ `\
uniform timelineUniforms {
  float year;
  float highlight;
  float highlightMix;
  float ghostAlpha;
  float glow;
} timeline;
`;

const timelineModule = {
  name: 'timeline',
  vs: /* glsl */ `
${uniformBlock}
in vec3 timeRanges;
out float timeline_visible;
float timeline_growth;
float timeline_ghost;
float timeline_glow;
`,
  fs: /* glsl */ `
${uniformBlock}
in float timeline_visible;
`,
  inject: {
    'vs:#main-start': /* glsl */ `
    timeline_visible = 1.0;
    timeline_growth = 1.0;
    timeline_ghost = 0.0;
    timeline_glow = 0.0;
    float tlExact = step(timeRanges.y - timeRanges.x, 0.5);
    if (tlExact > 0.5) {
      float age = timeline.year - timeRanges.x;
      timeline_visible = step(-1.0, age) * step(0.0001, age + 1.0);
      timeline_growth = clamp(age + 1.0, 0.0, 1.0);
      timeline_glow = timeline.glow * exp(-max(age, 0.0) / 3.5) * timeline_visible * step(1800.5, timeRanges.x);
    } else {
      timeline_visible = step(timeRanges.x, timeline.year);
      timeline_ghost = 1.0 - step(timeRanges.y, timeline.year);
    }
  `,
    'vs:#main-end': /* glsl */ `
    if (timeline_visible < 0.5) {
      gl_Position = vec4(0.0);
    }
  `,
    'vs:DECKGL_FILTER_GL_POSITION': /* glsl */ `
#ifdef TIMELINE_GROW
    if (timeline_growth < 0.999) {
      vec3 tlBase = project_position(geometry.worldPosition);
      vec3 tlPos = mix(tlBase, geometry.position.xyz, timeline_growth);
      position = project_common_position_to_clipspace(vec4(tlPos, 1.0));
    }
#endif
  `,
    'vs:DECKGL_FILTER_COLOR': /* glsl */ `
    float tlLum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    if (timeline.highlight >= 0.0 && abs(timeRanges.z - timeline.highlight) > 0.5) {
      vec3 dim = vec3(tlLum * 0.42 + 0.035);
      color.rgb = mix(color.rgb, dim, timeline.highlightMix);
    }
    if (timeline_ghost > 0.5) {
      color.rgb = mix(color.rgb, vec3(0.86, 0.84, 0.80) * (0.55 + tlLum), 0.35);
      color.a *= timeline.ghostAlpha;
    }
    color.rgb = mix(color.rgb, vec3(1.0, 0.94, 0.78), clamp(timeline_glow, 0.0, 0.85));
  `,
    'fs:DECKGL_FILTER_COLOR': /* glsl */ `
    if (timeline_visible < 0.5) discard;
  `
  },
  getUniforms: opts => {
    if (!opts || !('extensions' in opts)) return {};
    return {
      year: opts.timelineYear,
      highlight: opts.highlightPeriod,
      highlightMix: opts.highlightMix,
      ghostAlpha: opts.ghostAlpha,
      glow: opts.glow
    };
  },
  uniformTypes: {
    year: 'f32',
    highlight: 'f32',
    highlightMix: 'f32',
    ghostAlpha: 'f32',
    glow: 'f32'
  }
};

export class TimelineExtension extends LayerExtension {
  static extensionName = 'TimelineExtension';
  static defaultProps = {
    getTimeRange: {type: 'accessor', value: [0, 0, 0]},
    timelineYear: 3000,
    highlightPeriod: -1,
    highlightMix: 0,
    ghostAlpha: 0.2,
    glow: 0
  };

  constructor(opts = {}) {
    super({grow: false, ...opts});
  }

  getShaders(extension) {
    return {
      modules: [timelineModule],
      defines: extension.opts.grow ? {TIMELINE_GROW: 1} : {}
    };
  }

  initializeState() {
    this.getAttributeManager()?.add({
      timeRanges: {size: 3, stepMode: 'dynamic', accessor: 'getTimeRange'}
    });
  }

  draw() {
    const {extensions, timelineYear, highlightPeriod, highlightMix, ghostAlpha, glow} = this.props;
    this.setShaderModuleProps({
      timeline: {extensions, timelineYear, highlightPeriod, highlightMix, ghostAlpha, glow}
    });
  }
}

// Découpe du sol : la texture est transparente hors de Paris et sur l'eau.
const alphaCutModule = {
  name: 'alphaCut',
  inject: {
    'fs:DECKGL_FILTER_COLOR': /* glsl */ `
    if (color.a < 0.5) discard;
    color.a = 1.0;
  `
  }
};

export class AlphaCutExtension extends LayerExtension {
  static extensionName = 'AlphaCutExtension';
  getShaders() {
    return {modules: [alphaCutModule]};
  }
}

// Brume atmosphérique : les lointains se fondent dans le ciel, ce qui donne l'échelle.
const fogModule = {
  name: 'fog',
  vs: /* glsl */ `
uniform fogUniforms {
  float near;
  float far;
  float density;
  vec3 color;
} fog;
out float fog_amount;
`,
  fs: /* glsl */ `
uniform fogUniforms {
  float near;
  float far;
  float density;
  vec3 color;
} fog;
in float fog_amount;
`,
  inject: {
    'vs:DECKGL_FILTER_GL_POSITION': /* glsl */ `
    vec3 fogDelta = (geometry.position.xyz - project.cameraPosition) / project.commonUnitsPerMeter;
    fog_amount = fog.density * smoothstep(fog.near, fog.far, length(fogDelta));
  `,
    'fs:#main-end': /* glsl */ `
    if (!bool(picking.isActive)) {
      fragColor.rgb = mix(fragColor.rgb, fog.color, fog_amount);
    }
  `
  },
  getUniforms: opts => {
    if (!opts || !('extensions' in opts)) return {};
    const [near, far, density] = opts.fogRange;
    return {near, far, density, color: opts.fogColor};
  },
  uniformTypes: {near: 'f32', far: 'f32', density: 'f32', color: 'vec3<f32>'}
};

export class FogExtension extends LayerExtension {
  static extensionName = 'FogExtension';
  static defaultProps = {
    fogRange: [3000, 20000, 0.5],
    fogColor: [0.11, 0.13, 0.18]
  };

  getShaders() {
    return {modules: [fogModule]};
  }

  draw() {
    const {extensions, fogRange, fogColor} = this.props;
    this.setShaderModuleProps({fog: {extensions, fogRange, fogColor}});
  }
}
