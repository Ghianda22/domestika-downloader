import  {Browser, Cookie, Page} from 'puppeteer';
import * as cheerio from 'cheerio';
import { exec , ExecOptions } from 'child_process';
import fs from 'fs';
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import AnonymizeUAPlugin from 'puppeteer-extra-plugin-anonymize-ua'

// --- CONFIGURATION ---
const DEBUG = false;
// Url to the list to be downloaded
const LIST_URL = "https://www.domestika.org/LANG/ACCOUNT/courses_lists/LIST_NAME";
const SUBTITLE_LANG = 'it';
const MACHINE_OS: 'mac'|'win' = 'mac';

const COOKIES: Cookie[] = loadCookies('./cookies.json');
// --- END CONFIGURATION ---

main().then(() => process.exit(0));

/** Main function to orchestrate the process */
async function main(): Promise<void> {
    const browser = await puppeteer.use(StealthPlugin()).use(AnonymizeUAPlugin()).launch({ headless: false });
    const page = await setupPage(browser);

    await page.goto(LIST_URL);
    const courseLinks = await extractCourseLinks(page);

    console.log(`${courseLinks.length} Courses Detected`);

    for (const { title, link } of courseLinks) {
        console.log(`Scraping Course: ${title}`);
        await scrapeCourse(link, title);
    }

    console.log('All Courses Downloaded');
    await browser.close();
}

/** Load cookies from a JSON file */
function loadCookies(filePath: string): Cookie[] {
    const rawCookies = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const sessionCookie = rawCookies.find((cookie: any) => cookie.name === '_domestika_session');

    return [
        {
            name: '_domestika_session',
            value: sessionCookie?.value || '',
            domain: 'www.domestika.org',
            path: '/',
            expires: -1,
            size: 0,
            httpOnly: false,
            secure: true,
            session: false,
        },
    ];
}

/** Setup a Puppeteer page with common configurations */
async function setupPage(browser: Browser): Promise<Page> {
    await browser.setCookie(...COOKIES);
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(0);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['stylesheet', 'font', 'image'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    return page;
}

/** Extract course links and titles from the course list page */
async function extractCourseLinks(page: Page): Promise<{ title: string; link: string }[]> {
    const html = await page.content();
    const $ = cheerio.load(html);

    return $('h3.o-course-card__title a')
        .map((_, el) => ({
            title: $(el).text().trim(),
            link: $(el).attr('href') || '',
        }))
        .get();
}

/** Scrape a single course */
async function scrapeCourse(courseUrl: string, courseTitle: string): Promise<void> {
    const browser = await puppeteer.launch({ headless: true });
    const page = await setupPage(browser);

    await page.goto(`${courseUrl}/course`);
    const html = await page.content();
    const $ = cheerio.load(html);

    const courseUnits = $('h4.h2.unit-item__title a')
        .map((_, el) => $(el).attr('href') || '')
        .get();

    console.log(`${courseUnits.length} Units Detected`);

    const sanitizedTitle = sanitizeFilename(courseTitle);
    const videos = [];

    for (const unitUrl of courseUnits) {
        const unitVideos = await scrapeUnitVideos(page, unitUrl);
        videos.push(...unitVideos);
    }

    console.log('All Videos Found');

    await downloadVideos(videos, sanitizedTitle);

    console.log(`Course downloaded: ${sanitizedTitle}`);
    await browser.close();
}

/** Scrape videos from a single unit */
async function scrapeUnitVideos(page: Page, unitUrl: string): Promise<any[]> {
    await page.goto(unitUrl);

    // @ts-ignore: Custom DOM structure
    const data = await page.evaluate(() => window.__INITIAL_PROPS__);
    const html = await page.content();
    const $ = cheerio.load(html);

    const section = sanitizeFilename(
        $('h2.h3.course-header-new__subtitle').text().trim()
    );

    return data?.videos?.map((video: any) => ({
        playbackURL: video.video.playbackURL,
        title: sanitizeFilename(video.video.title),
        section,
    })) || [];
}

/** Download videos using the appropriate tool */
async function downloadVideos(
    videos: { playbackURL: string; title: string; section: string }[],
    courseTitle: string
): Promise<void> {
    const options: ExecOptions = { maxBuffer: 1024 * 1024 * 10 };

    for (const [index, video] of videos.entries()) {
        const directory = `domestika_courses/${courseTitle}/${video.section}/`;
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        const command =
            MACHINE_OS === 'win'
                ? `N_m3u8DL-RE "${video.playbackURL}" --save-dir "${directory}" --save-name "${index}_${video.title}"`
                : `yt-dlp --output "${index}_${video.title}" --paths "${directory}" --sub-langs "en,${SUBTITLE_LANG}" --embed-subs "${video.playbackURL}"`;

        try {
            console.log(`Downloading ${index}_${video.title}`);
            const downloadProcess = exec(command, options);
            downloadProcess.stdout.on('data', function(data) {
                if (DEBUG) console.log(data);
            });

            if (DEBUG) console.log(`Downloaded: ${video.title}`);
        } catch (error) {
            console.error(`Error downloading video: ${video.title}`, error);
        }
    }
}

/** Sanitize filenames by removing invalid characters */
function sanitizeFilename(name: string): string {
    return name.replace(/[/\\?%*:|"<>]/g, '-').trim();
}
