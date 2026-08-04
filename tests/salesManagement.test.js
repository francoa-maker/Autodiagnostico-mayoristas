import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERNAL_RECIPIENTS,
  invalidEmails,
  mergeRequiredRecipients,
  salesManagementCode,
  sanitizeEmailHtml,
  sellerCodeFor
} from "../src/salesManagement.js";

describe("gestión de venta", () => {
  it("asigna los códigos acordados a los cuatro vendedores", () => {
    expect(sellerCodeFor("m.vaistich@patagoniatools.com.ar")).toBe("MRT");
    expect(sellerCodeFor("franco.a@patagoniatools.com.ar")).toBe("FRA");
    expect(sellerCodeFor("l.fonte@patagoniatools.com.ar")).toBe("LFO");
    expect(sellerCodeFor("guillermo.distasio@patagoniatools.com.ar")).toBe("GDS");
    expect(salesManagementCode("MRT", 46)).toBe("MRT-46");
  });

  it("incluye las dos casillas de Andrea y todo el equipo obligatorio", () => {
    expect(DEFAULT_INTERNAL_RECIPIENTS).toContain("tomas.dr@patagoniatools.com.ar");
    expect(DEFAULT_INTERNAL_RECIPIENTS).toContain("andrea.villamizar@patagoniatools.com.ar");
    expect(DEFAULT_INTERNAL_RECIPIENTS).toHaveLength(10);
    const recipients = mergeRequiredRecipients({
      clientEmail: "administracion@leoscanner.com",
      internalRecipients: DEFAULT_INTERNAL_RECIPIENTS,
      additionalRecipients: "extra@empresa.com, ADMINISTRACION@LEOSCANNER.COM"
    });
    expect(recipients[0]).toBe("administracion@leoscanner.com");
    expect(recipients).toContain("extra@empresa.com");
    expect(recipients.filter((email) => email === "administracion@leoscanner.com")).toHaveLength(1);
    expect(invalidEmails(recipients)).toEqual([]);
  });

  it("elimina contenido ejecutable del HTML editable", () => {
    const result = sanitizeEmailHtml('<p onclick="hack()">Hola</p><script>alert(1)</script><img src="javascript:alert(2)" onerror="hack()">');
    expect(result).toContain("<p>Hola</p>");
    expect(result).not.toMatch(/script|onclick|onerror|javascript:/i);
  });
});
