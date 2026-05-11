/* mtoc runtime: numbl-compatible format engine shared by fprintf and
 * sprintf.
 *
 * Mirrors numbl's `sprintfFormat`
 * (numbl/src/numbl-core/helpers/string.ts) byte-for-byte:
 *   - spec set: d i u f e E g G x X o s c %
 *   - flags  - + 0 # space; precision `.N`; width digits; `*` consumes
 *     the next numeric arg as a width
 *   - escapes \n \t \\ interpreted AT FORMAT TIME (matching the numbl
 *     lexer, which preserves backslash bytes verbatim)
 *   - numeric tensors flatten column-major into the scalar stream;
 *     format string cycles through the args until the stream is
 *     exhausted (with a "no arg consumed this pass" guard against
 *     infinite output)
 *
 * Output goes through a caller-supplied `mtoc__writer_fn` callback so
 * the same walker drives fprintf (FILE* sink) and sprintf (growable-
 * buffer sink).
 *
 * Argument transport: each call hands the walker an array of
 * `mtoc_fprintf_arg_t` (a tagged union). The codegen builds the array
 * at the call site via a C99 compound literal, keeping the call shape
 * a single C expression even for variadic arities.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <complex.h>

/* Tag identifying the payload variant of a single mtoc_fprintf_arg_t.
 * Values are stable — the engine switches on them. */
enum {
  MTOC_FA_DOUBLE = 1,
  MTOC_FA_COMPLEX = 2,
  MTOC_FA_TEXT = 3,
  MTOC_FA_TENSOR = 4   /* real OR complex tensor; engine probes .imag */
};

typedef struct {
  int kind;
  union {
    double d;
    double _Complex z;
    mtoc_text_view_t t;
    const mtoc_tensor_t *tensor;
  } u;
} mtoc_fprintf_arg_t;

/* Per-slot value handed to one format spec, after expanding any
 * tensor argument into its flattened element stream. */
typedef struct {
  int kind;           /* MTOC_FA_DOUBLE / _COMPLEX / _TEXT */
  double d;
  double _Complex z;
  mtoc_text_view_t t;
} mtoc__slot_t;

/* Iterator state over the (tagged) arg array with lazy column-major
 * tensor flattening. */
typedef struct {
  const mtoc_fprintf_arg_t *args;
  int nargs;
  int arg_idx;             /* next un-touched entry of args[] */
  int in_tensor;           /* 1 iff currently iterating a flattened tensor */
  const mtoc_tensor_t *cur_t;
  long t_idx;
  long t_count;
} mtoc__arg_iter_t;

typedef void (*mtoc__writer_fn)(void *ctx, const char *bytes, long len);

/* Advance the iterator to the next scalar slot. Returns 0 when no
 * more slots are available (caller stops cycling). */
static int mtoc__next_slot(mtoc__arg_iter_t *it, mtoc__slot_t *out) {
  while (1) {
    if (it->in_tensor) {
      if (it->t_idx >= it->t_count) {
        it->in_tensor = 0;
        it->cur_t = (const mtoc_tensor_t *)0;
        continue;
      }
      const mtoc_tensor_t *t = it->cur_t;
      long i = it->t_idx++;
      if (t->imag) {
        out->kind = MTOC_FA_COMPLEX;
        out->z = t->real[i] + t->imag[i] * I;
      } else {
        out->kind = MTOC_FA_DOUBLE;
        out->d = t->real[i];
      }
      return 1;
    }
    if (it->arg_idx >= it->nargs) return 0;
    const mtoc_fprintf_arg_t *a = &it->args[it->arg_idx++];
    switch (a->kind) {
      case MTOC_FA_DOUBLE:
        out->kind = MTOC_FA_DOUBLE;
        out->d = a->u.d;
        return 1;
      case MTOC_FA_COMPLEX:
        out->kind = MTOC_FA_COMPLEX;
        out->z = a->u.z;
        return 1;
      case MTOC_FA_TEXT:
        out->kind = MTOC_FA_TEXT;
        out->t = a->u.t;
        return 1;
      case MTOC_FA_TENSOR: {
        const mtoc_tensor_t *t = a->u.tensor;
        long n = 1;
        for (int k = 0; k < t->ndim; k++) n *= t->dims[k];
        if (n <= 0) continue;   /* empty tensor — skip */
        it->in_tensor = 1;
        it->cur_t = t;
        it->t_idx = 0;
        it->t_count = n;
        break;
      }
      default:
        return 0;
    }
  }
}

/* True iff the iterator has any remaining slot. */
static int mtoc__iter_has_more(const mtoc__arg_iter_t *it) {
  if (it->in_tensor && it->t_idx < it->t_count) return 1;
  if (it->arg_idx < it->nargs) return 1;
  return 0;
}

/* Number of slots consumed so far — used to detect a no-progress
 * pass over a format with no specs. */
static long mtoc__iter_consumed(const mtoc__arg_iter_t *it) {
  /* arg_idx counts args fully consumed; if inside a tensor, t_idx
   * counts elements of the current tensor already produced. */
  long n = (long)it->arg_idx;
  if (it->in_tensor) n = (long)(it->arg_idx - 1) + (long)it->t_idx;
  /* Above formula is monotonic across calls, which is all the caller
   * needs (it just compares the value to a snapshot from the start
   * of the pass). */
  return n;
}

/* Emit a small byte buffer through the writer. */
static void mtoc__emit_bytes(mtoc__writer_fn writer, void *ctx,
                             const char *bytes, long len) {
  if (len > 0) writer(ctx, bytes, len);
}

/* Emit a NUL-terminated C string through the writer. */
static void mtoc__emit_cstr(mtoc__writer_fn writer, void *ctx, const char *s) {
  mtoc__emit_bytes(writer, ctx, s, (long)strlen(s));
}

/* Append numbl's `applyWidth` semantics: pad `s` (length `slen`) to
 * `width` using `pad_char` (' ' or '0'), respecting left-align. */
static void mtoc__emit_padded(mtoc__writer_fn writer, void *ctx,
                              const char *s, long slen,
                              long width, char pad_char, int left_align) {
  if (width <= slen) {
    mtoc__emit_bytes(writer, ctx, s, slen);
    return;
  }
  long pad_len = width - slen;
  if (left_align) {
    mtoc__emit_bytes(writer, ctx, s, slen);
    for (long i = 0; i < pad_len; i++) writer(ctx, " ", 1);
  } else {
    for (long i = 0; i < pad_len; i++) writer(ctx, &pad_char, 1);
    mtoc__emit_bytes(writer, ctx, s, slen);
  }
}

/* Parse the spec body (between '%' and the type char) — fills
 * `width` (0 if absent), `prec` (-1 if absent), and the flag set.
 * Resolves '*' for width by consuming one numeric slot via the
 * iterator. Returns 1 on success, 0 if the iterator ran out while
 * resolving '*'. */
static int mtoc__parse_spec(const char *spec, long spec_len,
                            mtoc__arg_iter_t *it,
                            long *out_width, int *out_prec,
                            int *out_has_plus, int *out_has_space,
                            int *out_left_align, int *out_zero_pad) {
  long width = 0;
  int prec = -1;
  int has_plus = 0, has_space = 0, left_align = 0, zero_pad = 0;
  int in_prec = 0;
  /* spec begins with '%'; iterate over its body. */
  for (long i = 1; i < spec_len; i++) {
    char c = spec[i];
    if (in_prec) {
      if (c >= '0' && c <= '9') {
        if (prec < 0) prec = 0;
        prec = prec * 10 + (c - '0');
        continue;
      }
      in_prec = 0;
    }
    if (c == '.') {
      in_prec = 1;
      prec = 0;
      continue;
    }
    if (c == '-') { left_align = 1; continue; }
    if (c == '+') { has_plus = 1; continue; }
    if (c == ' ') { has_space = 1; continue; }
    if (c == '#') { /* parsed but no behavior */ continue; }
    if (c == '0' && width == 0) { zero_pad = 1; continue; }
    if (c >= '0' && c <= '9') {
      width = width * 10 + (c - '0');
      continue;
    }
    if (c == '*') {
      /* `*` width: consume one numeric slot from the iterator. */
      mtoc__slot_t slot;
      if (!mtoc__next_slot(it, &slot)) return 0;
      double v = (slot.kind == MTOC_FA_DOUBLE) ? slot.d
               : (slot.kind == MTOC_FA_COMPLEX) ? creal(slot.z) : 0.0;
      long n = (long)floor(v + 0.5);
      width = width * 1 + (n > 0 ? n : 0);  /* numbl appends digits */
      continue;
    }
    /* Anything else is unexpected — numbl carries it through
     * applyWidth as part of the spec text. We ignore it for width
     * but it has no other effect. */
  }
  if (zero_pad && left_align) zero_pad = 0;   /* numbl's rule */
  *out_width = width;
  *out_prec = prec;
  *out_has_plus = has_plus;
  *out_has_space = has_space;
  *out_left_align = left_align;
  *out_zero_pad = zero_pad;
  return 1;
}

/* Format a real number as JS `String(n)` would — used by %s on a
 * numeric arg (numbl's `toString` path). Handles NaN / +-Inf and
 * defers to `%g` shortened representation for finite values. */
static long mtoc__num_to_str(char *buf, size_t cap, double x) {
  if (isnan(x)) return (long)snprintf(buf, cap, "NaN");
  if (isinf(x)) return (long)snprintf(buf, cap, x > 0 ? "Infinity" : "-Infinity");
  /* Integer-valued doubles in the safe-integer range render without
   * a decimal point — matches `String(n)` exactly. */
  if (fabs(x) < 1e16 && x == (double)(long long)x) {
    return (long)snprintf(buf, cap, "%lld", (long long)x);
  }
  /* For non-integers, use shortest-round-trip "%.17g" then trim. */
  long n = (long)snprintf(buf, cap, "%.17g", x);
  return n;
}

/* Emit one `\` escape sequence — numbl interprets only \n, \t, \\
 * at format time; any other `\x` passes through verbatim. */
static long mtoc__emit_escape(mtoc__writer_fn writer, void *ctx,
                               char next) {
  switch (next) {
    case 'n': writer(ctx, "\n", 1); return 1;
    case 't': writer(ctx, "\t", 1); return 1;
    case '\\': writer(ctx, "\\", 1); return 1;
    default: {
      char buf[2] = { '\\', next };
      writer(ctx, buf, 2);
      return 1;
    }
  }
}

/* Emit a %d / %i / %u slot. Mirrors numbl's int branch exactly:
 *   - non-integer (or negative for %u) → fall back to %e prec=6
 *     with 2-digit-padded exponent.
 *   - otherwise render |x| as decimal, prepend sign per flags,
 *     and apply width/zero-pad. */
static void mtoc__emit_int(mtoc__writer_fn writer, void *ctx,
                            const char *spec, long spec_len,
                            mtoc__arg_iter_t *it, char type_ch,
                            double raw) {
  int is_int = isfinite(raw) && raw == (double)(long long)raw
               && fabs(raw) < 1e18;
  int can_int = is_int;
  if (type_ch == 'u' && raw < 0.0) can_int = 0;
  long width;
  int prec, has_plus, has_space, left_align, zero_pad;
  if (!mtoc__parse_spec(spec, spec_len, it,
                        &width, &prec, &has_plus, &has_space,
                        &left_align, &zero_pad)) {
    return;
  }
  if (!can_int) {
    /* Non-int (or %u negative) — render as %e prec 6 with 2-digit exp. */
    char ebuf[64];
    long elen = (long)snprintf(ebuf, sizeof(ebuf), "%.*e",
                                prec >= 0 ? prec : 6, raw);
    /* Pad exponent to ≥2 digits (numbl rule). */
    /* Look for 'e[+-]<digit>$'. */
    if (elen >= 3) {
      char *e = strchr(ebuf, 'e');
      if (e && (e[1] == '+' || e[1] == '-') &&
          e[2] >= '0' && e[2] <= '9' && e[3] == '\0') {
        char tail = e[2];
        e[2] = '0';
        e[3] = tail;
        e[4] = '\0';
        elen++;
      }
    }
    mtoc__emit_padded(writer, ctx, ebuf, elen, width,
                      zero_pad ? '0' : ' ', left_align);
    return;
  }
  /* Integer formatting. */
  char ibuf[32];
  long long n_int = (long long)raw;
  long ilen = (long)snprintf(ibuf, sizeof(ibuf), "%lld",
                              n_int < 0 ? -n_int : n_int);
  char sign_ch = 0;
  if (n_int < 0) sign_ch = '-';
  else if (has_plus) sign_ch = '+';
  else if (has_space) sign_ch = ' ';
  long sign_len = sign_ch ? 1 : 0;
  long total = sign_len + ilen;
  if (width <= total) {
    if (sign_ch) writer(ctx, &sign_ch, 1);
    mtoc__emit_bytes(writer, ctx, ibuf, ilen);
    return;
  }
  long pad = width - total;
  if (left_align) {
    if (sign_ch) writer(ctx, &sign_ch, 1);
    mtoc__emit_bytes(writer, ctx, ibuf, ilen);
    for (long i = 0; i < pad; i++) writer(ctx, " ", 1);
  } else if (zero_pad) {
    if (sign_ch) writer(ctx, &sign_ch, 1);
    for (long i = 0; i < pad; i++) writer(ctx, "0", 1);
    mtoc__emit_bytes(writer, ctx, ibuf, ilen);
  } else {
    for (long i = 0; i < pad; i++) writer(ctx, " ", 1);
    if (sign_ch) writer(ctx, &sign_ch, 1);
    mtoc__emit_bytes(writer, ctx, ibuf, ilen);
  }
}

/* Emit %f / %e / %E / %g / %G slot — defers to snprintf for the
 * numeric body, applies sign-prefix and width afterwards. */
static void mtoc__emit_float(mtoc__writer_fn writer, void *ctx,
                              const char *spec, long spec_len,
                              mtoc__arg_iter_t *it, char type_ch,
                              double x) {
  long width;
  int prec, has_plus, has_space, left_align, zero_pad;
  if (!mtoc__parse_spec(spec, spec_len, it,
                        &width, &prec, &has_plus, &has_space,
                        &left_align, &zero_pad)) {
    return;
  }
  if (!isfinite(x)) {
    const char *s = isnan(x) ? "NaN" : (x > 0 ? "Infinity" : "-Infinity");
    long slen = (long)strlen(s);
    mtoc__emit_padded(writer, ctx, s, slen, width,
                      zero_pad ? ' ' : ' ', left_align);
    return;
  }
  int default_prec = 6;
  if (prec < 0) prec = default_prec;

  char buf[96];
  long len = 0;
  if (type_ch == 'f') {
    len = (long)snprintf(buf, sizeof(buf), "%.*f", prec, fabs(x));
  } else if (type_ch == 'e' || type_ch == 'E') {
    len = (long)snprintf(buf, sizeof(buf), "%.*e", prec, fabs(x));
    /* Pad exponent to ≥2 digits. */
    char *e = strchr(buf, 'e');
    if (e && (e[1] == '+' || e[1] == '-') &&
        e[2] >= '0' && e[2] <= '9' && e[3] == '\0') {
      char tail = e[2];
      e[2] = '0';
      e[3] = tail;
      e[4] = '\0';
      len++;
    }
    if (type_ch == 'E') {
      for (long i = 0; i < len; i++) {
        if (buf[i] == 'e') buf[i] = 'E';
      }
    }
  } else {
    /* %g / %G — C-style: %e if exp < -4 or >= prec, else %f stripped. */
    int gprec = prec > 0 ? prec : 1;
    if (x == 0.0) {
      buf[0] = '0';
      buf[1] = '\0';
      len = 1;
    } else {
      double ax = fabs(x);
      int exp10 = (int)floor(log10(ax));
      if (exp10 < -4 || exp10 >= gprec) {
        len = (long)snprintf(buf, sizeof(buf), "%.*e", gprec - 1, ax);
        /* Strip trailing zeros from mantissa, then pad exp ≥2 digits. */
        char *e = strchr(buf, 'e');
        if (e) {
          char *m_end = e - 1;
          while (m_end > buf && *m_end == '0') m_end--;
          if (m_end > buf && *m_end == '.') m_end--;
          /* Shift exponent down to right after the mantissa. */
          long m_keep = m_end - buf + 1;
          long e_len = (long)strlen(e);
          memmove(buf + m_keep, e, (size_t)e_len + 1);
          len = m_keep + e_len;
          /* Pad exp ≥2 digits. */
          e = buf + m_keep;
          if ((e[1] == '+' || e[1] == '-') &&
              e[2] >= '0' && e[2] <= '9' && e[3] == '\0') {
            char tail = e[2];
            e[2] = '0';
            e[3] = tail;
            e[4] = '\0';
            len++;
          }
        }
      } else {
        /* Fixed notation — emulate JS Number.prototype.toPrecision
         * with trailing-zero strip. */
        int frac = gprec - 1 - exp10;
        if (frac < 0) frac = 0;
        len = (long)snprintf(buf, sizeof(buf), "%.*f", frac, ax);
        if (strchr(buf, '.')) {
          while (len > 0 && buf[len - 1] == '0') len--;
          if (len > 0 && buf[len - 1] == '.') len--;
          buf[len] = '\0';
        }
      }
    }
    if (type_ch == 'G') {
      for (long i = 0; i < len; i++) {
        if (buf[i] >= 'a' && buf[i] <= 'z') buf[i] = (char)(buf[i] - 32);
      }
    }
  }
  /* Apply sign prefix and width. */
  char sign_ch = 0;
  if (x < 0.0 && type_ch == 'f') sign_ch = '-';
  else if (x < 0.0) sign_ch = '-';
  else if (has_plus) sign_ch = '+';
  else if (has_space) sign_ch = ' ';
  long sign_len = sign_ch ? 1 : 0;
  long total = sign_len + len;
  if (width <= total) {
    if (sign_ch) writer(ctx, &sign_ch, 1);
    mtoc__emit_bytes(writer, ctx, buf, len);
    return;
  }
  long pad = width - total;
  if (left_align) {
    if (sign_ch) writer(ctx, &sign_ch, 1);
    mtoc__emit_bytes(writer, ctx, buf, len);
    for (long i = 0; i < pad; i++) writer(ctx, " ", 1);
  } else if (zero_pad) {
    if (sign_ch) writer(ctx, &sign_ch, 1);
    for (long i = 0; i < pad; i++) writer(ctx, "0", 1);
    mtoc__emit_bytes(writer, ctx, buf, len);
  } else {
    for (long i = 0; i < pad; i++) writer(ctx, " ", 1);
    if (sign_ch) writer(ctx, &sign_ch, 1);
    mtoc__emit_bytes(writer, ctx, buf, len);
  }
}

/* Emit %x / %X / %o — round-to-int absolute value, then convert. */
static void mtoc__emit_xo(mtoc__writer_fn writer, void *ctx,
                          const char *spec, long spec_len,
                          mtoc__arg_iter_t *it, char type_ch,
                          double raw) {
  long width;
  int prec, has_plus, has_space, left_align, zero_pad;
  if (!mtoc__parse_spec(spec, spec_len, it,
                        &width, &prec, &has_plus, &has_space,
                        &left_align, &zero_pad)) {
    return;
  }
  long long n = (long long)floor(fabs(raw) + 0.5);
  char buf[32];
  long len = 0;
  if (type_ch == 'o') {
    len = (long)snprintf(buf, sizeof(buf), "%llo", n);
  } else {
    len = (long)snprintf(buf, sizeof(buf), "%llx", n);
    if (type_ch == 'X') {
      for (long i = 0; i < len; i++) {
        if (buf[i] >= 'a' && buf[i] <= 'f') buf[i] = (char)(buf[i] - 32);
      }
    }
  }
  mtoc__emit_padded(writer, ctx, buf, len, width,
                    zero_pad ? '0' : ' ', left_align);
}

/* Emit %s — text view (string or char-array) goes through verbatim;
 * a numeric slot routes through `String(n)` semantics. */
static void mtoc__emit_s(mtoc__writer_fn writer, void *ctx,
                         const char *spec, long spec_len,
                         mtoc__arg_iter_t *it, const mtoc__slot_t *slot) {
  long width;
  int prec, has_plus, has_space, left_align, zero_pad;
  if (!mtoc__parse_spec(spec, spec_len, it,
                        &width, &prec, &has_plus, &has_space,
                        &left_align, &zero_pad)) {
    return;
  }
  const char *data = (const char *)0;
  long slen = 0;
  char numbuf[64];
  if (slot->kind == MTOC_FA_TEXT) {
    data = slot->t.data;
    slen = slot->t.len > 0 ? slot->t.len : 0;
  } else if (slot->kind == MTOC_FA_DOUBLE) {
    slen = mtoc__num_to_str(numbuf, sizeof(numbuf), slot->d);
    data = numbuf;
  } else {
    /* Complex %s — render as "<re>+<im>i" via the existing format helper. */
    char cbuf[128];
    long n = (long)mtoc_format_complex(cbuf, sizeof(cbuf), slot->z);
    if (n < 0) n = 0;
    if (n > (long)sizeof(cbuf)) n = (long)sizeof(cbuf);
    mtoc__emit_padded(writer, ctx, cbuf, n, width, ' ', left_align);
    return;
  }
  mtoc__emit_padded(writer, ctx, data, slen, width, ' ', left_align);
}

/* The main walker. Loops over `fmt` consuming args; cycles through
 * the format string until the arg stream is exhausted, with a
 * "made no progress this pass" guard against infinite output on a
 * format with no `%` specifiers. */
static void mtoc__format_walk(mtoc__writer_fn writer, void *ctx,
                              mtoc_text_view_t fmt,
                              int nargs, const mtoc_fprintf_arg_t *args) {
  mtoc__arg_iter_t it;
  it.args = args;
  it.nargs = nargs;
  it.arg_idx = 0;
  it.in_tensor = 0;
  it.cur_t = (const mtoc_tensor_t *)0;
  it.t_idx = 0;
  it.t_count = 0;

  long fmt_len = fmt.len > 0 ? fmt.len : 0;
  if (fmt_len == 0 || !fmt.data) return;

  do {
    long start_consumed = mtoc__iter_consumed(&it);
    long i = 0;
    int out_of_args = 0;
    while (i < fmt_len && !out_of_args) {
      char c = fmt.data[i];
      if (c == '%' && i + 1 < fmt_len) {
        long spec_start = i;
        i++;
        while (i < fmt_len &&
               !strchr("dfigeEsoxXuc%", fmt.data[i])) {
          i++;
        }
        if (i >= fmt_len) {
          /* Spec body ran to end-of-string with no recognized type
           * char (e.g. `'%G\n'` — numbl's inner spec-end set is
           * `"dfigeEsoxXuc%"`, no uppercase G). Numbl emits nothing
           * here and stops the pass without consuming an arg; mtoc
           * matches for byte-for-byte parity. */
          break;
        }
        char type_ch = fmt.data[i++];
        long spec_len = i - 1 - spec_start;   /* exclude type char */
        const char *spec = fmt.data + spec_start;
        if (type_ch == '%') {
          writer(ctx, "%", 1);
          continue;
        }
        mtoc__slot_t slot;
        if (!mtoc__next_slot(&it, &slot)) {
          out_of_args = 1;
          break;
        }
        double dval = (slot.kind == MTOC_FA_DOUBLE) ? slot.d
                    : (slot.kind == MTOC_FA_COMPLEX) ? creal(slot.z)
                    : 0.0;
        switch (type_ch) {
          case 'd':
          case 'i':
          case 'u':
            mtoc__emit_int(writer, ctx, spec, spec_len, &it,
                            type_ch, dval);
            break;
          case 'f':
          case 'e':
          case 'E':
          case 'g':
          case 'G':
            mtoc__emit_float(writer, ctx, spec, spec_len, &it,
                              type_ch, dval);
            break;
          case 'x':
          case 'X':
          case 'o':
            mtoc__emit_xo(writer, ctx, spec, spec_len, &it,
                          type_ch, dval);
            break;
          case 's':
            mtoc__emit_s(writer, ctx, spec, spec_len, &it, &slot);
            break;
          case 'c': {
            int code = (int)floor(dval + 0.5);
            if (code < 0) code = 0;
            if (code > 0x10FFFF) code = 0;
            /* Emit as a single byte for code points <128, else as a
             * minimal UTF-8 sequence so non-ASCII characters survive. */
            if (code < 0x80) {
              char ch = (char)code;
              writer(ctx, &ch, 1);
            } else if (code < 0x800) {
              char b[2];
              b[0] = (char)(0xC0 | (code >> 6));
              b[1] = (char)(0x80 | (code & 0x3F));
              writer(ctx, b, 2);
            } else if (code < 0x10000) {
              char b[3];
              b[0] = (char)(0xE0 | (code >> 12));
              b[1] = (char)(0x80 | ((code >> 6) & 0x3F));
              b[2] = (char)(0x80 | (code & 0x3F));
              writer(ctx, b, 3);
            } else {
              char b[4];
              b[0] = (char)(0xF0 | (code >> 18));
              b[1] = (char)(0x80 | ((code >> 12) & 0x3F));
              b[2] = (char)(0x80 | ((code >> 6) & 0x3F));
              b[3] = (char)(0x80 | (code & 0x3F));
              writer(ctx, b, 4);
            }
            break;
          }
          default:
            /* Unknown spec — emit spec text + type char verbatim
             * (matches numbl's fallthrough that consumes one arg
             * and outputs `spec + ch`). The arg has already been
             * consumed via mtoc__next_slot above. */
            mtoc__emit_bytes(writer, ctx, spec, spec_len + 1);
            break;
        }
      } else if (c == '\\' && i + 1 < fmt_len) {
        i++;
        i += mtoc__emit_escape(writer, ctx, fmt.data[i]);
      } else {
        writer(ctx, fmt.data + i, 1);
        i++;
      }
    }
    /* No progress this pass — stop to avoid infinite output. */
    if (mtoc__iter_consumed(&it) == start_consumed) break;
  } while (mtoc__iter_has_more(&it));
}
