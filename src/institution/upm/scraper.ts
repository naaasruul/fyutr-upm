const BASE = "https://esmp.upm.edu.my";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// UPM day codes: A/AH=Ahad(Sun), I=Isnin(Mon), S=Selasa(Tue),
//   R=Rabu(Wed), K=Khamis(Thu), J=Jumaat(Fri), SA=Sabtu(Sat)
const DAY_MAP: Record<string, number> = {
  AH: 0, A: 0,
  I: 1,
  S: 2,
  R: 3,
  K: 4,
  J: 5,
  SA: 6,
};

export interface TimeSlot {
  day: number;
  start: string;
  end: string;
  instructor: string | null;
  location: string | null;
}

export interface Schedule {
  code: string;
  title: string;
  creditHours: number | null;
  section: string | number | null;
  timeSlots: TimeSlot[];
}

export interface SemesterCalendar {
  title: string | null;
  schedules: Schedule[];
}

function parseMasa(code: string, location: string | null): TimeSlot[] {
  const slots: TimeSlot[] = [];
  if (!code?.trim()) return slots;
  for (const part of code.split(/[;,/]+/).map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z]+)\s*(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) continue;
    const key = m[1].toUpperCase();
    // Two-char prefix (SA, AH) takes precedence over single-char
    const day = DAY_MAP[key] ?? DAY_MAP[key[0]];
    if (day === undefined) continue;
    const startH = parseInt(m[2]);
    const endH = m[3] ? parseInt(m[3]) : startH + 1;
    slots.push({
      day,
      start: `${String(startH).padStart(2, "0")}:00`,
      end: `${String(endH).padStart(2, "0")}:00`,
      instructor: null,
      location,
    });
  }
  return slots;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function parseCourseText(text: string): {
  code: string;
  name: string;
  credit: string;
} {
  text = text.replace(/\s+/g, " ").trim();
  const m = text.match(
    /^([A-Z]{2,4}\d{3,4})\s*-\s*(.*?)(?:\s+(\d+\(\d+\+\d+\)))?$/,
  );
  if (!m) return { code: text, name: "", credit: "" };
  return { code: m[1], name: m[2].trim(), credit: m[3] || "" };
}

function parseCreditHours(credit: string): number | null {
  const m = credit.match(/^(\d+)/);
  return m ? parseInt(m[1]) : null;
}

export class UPMScraper {
  private cookies: string[] = [];

  private updateCookies(setCookie: string | null) {
    if (!setCookie) return;
    const newCookies = setCookie
      .split(/,(?=[^;]+=[^;]+)/)
      .map((c) => c.split(";")[0].trim());
    newCookies.forEach((nc) => {
      const name = nc.split("=")[0];
      this.cookies = this.cookies.filter((c) => !c.startsWith(name + "="));
      this.cookies.push(nc);
    });
  }

  private getCookieHeader() {
    return this.cookies.join("; ");
  }

  async scrape(
    studentId: string,
    password: string,
  ): Promise<SemesterCalendar[]> {
    // 1. Hit setup page first to get session cookie (required by SMP)
    const setupRes = await fetch(
      `${BASE}/smp/action/security/loginSmpSetup`,
      { headers: { "User-Agent": UA } },
    );
    this.updateCookies(setupRes.headers.get("set-cookie"));

    // 2. Login with the exact payload SMP expects
    const loginBody = new URLSearchParams({
      userName: studentId,
      password,
      device: "PC",
      "butangsubmit.x": "1",
      "butangsubmit.y": "1",
    });

    const loginRes = await fetch(`${BASE}/smp/action/security/loginSmp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        Cookie: this.getCookieHeader(),
      },
      body: loginBody.toString(),
      redirect: "follow",
    });
    this.updateCookies(loginRes.headers.get("set-cookie"));

    const loginHtml = await loginRes.text();
    const loginFailed =
      loginHtml.includes('name="Security.LoginForm"') ||
      loginHtml.includes('id="userName"');
    if (loginFailed) {
      throw new Error(
        "Login failed: Invalid credentials or redirection. Please check your Student ID and Password.",
      );
    }

    // 3. Fetch class timetable via Ajax endpoint
    const timetableRes = await fetch(
      `${BASE}/smp/action/portal/student/MyTimetable/MTT_GetJadualWaktuKuliahPelajar_AjaxSetupAction`,
      {
        headers: {
          "User-Agent": UA,
          Cookie: this.getCookieHeader(),
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${BASE}/smp/`,
        },
      },
    );
    const html = await timetableRes.text();

    return [{ title: "Current Semester", schedules: this.parseUPMTable(html) }];
  }

  private parseUPMTable(html: string): Schedule[] {
    // Locate the sortablescroll table; fall back to any table with "MASA KULIAH"
    let tableHtml = "";
    const scrollMatch = html.match(
      /<table[^>]*class="[^"]*sortablescroll[^"]*"[^>]*>([\s\S]*?)<\/table>/i,
    );
    if (scrollMatch) {
      tableHtml = scrollMatch[1];
    } else {
      const all = html.match(/<table[^>]*>([\s\S]*?)<\/table>/gi) || [];
      for (const t of all) {
        if (t.toUpperCase().includes("MASA KULIAH")) {
          tableHtml = t;
          break;
        }
      }
    }
    if (!tableHtml) return [];

    const schedules: Schedule[] = [];
    const rowRegex = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowContent = rowMatch[2];
      if (rowContent.includes("<th")) continue;

      const cells: string[] = [];
      const firstCellAttrs: string[] = [];
      const cellRegex = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
      let cellMatch: RegExpExecArray | null;

      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        if (cells.length === 0) firstCellAttrs.push(cellMatch[1]);
        cells.push(stripTags(cellMatch[2]));
      }

      if (cells.length < 9) continue;

      // Continuation row: first <td> has mergecell attribute or is empty
      const isContinuation =
        (firstCellAttrs[0] ?? "").toLowerCase().includes("mergecell") ||
        !cells[0]?.trim();

      if (!isContinuation) {
        const { code, name, credit } = parseCourseText(cells[1]);
        const lectureVenue = cells[5] || null;
        const labVenue = cells[8] || null;

        schedules.push({
          code,
          title: name,
          creditHours: parseCreditHours(credit),
          section: parseInt(cells[2]) || null,
          timeSlots: [
            ...parseMasa(cells[3], lectureVenue),
            ...parseMasa(cells[7], labVenue),
          ],
        });
      } else if (schedules.length > 0) {
        const last = schedules[schedules.length - 1];
        const lectureVenue = cells[5] || (last.timeSlots[0]?.location ?? null);
        const labVenue = cells[8] || null;
        for (const slot of parseMasa(cells[3], lectureVenue))
          last.timeSlots.push(slot);
        for (const slot of parseMasa(cells[7], labVenue))
          last.timeSlots.push(slot);
      }
    }

    return schedules;
  }
}
