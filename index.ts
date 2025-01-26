import puppeteer, { Cookie, Page } from 'puppeteer';
import cheerio from 'cheerio';
import { promisify } from 'util';
import {exec as execCallback, ExecOptions} from 'child_process';
import fs from 'fs';

const exec: (command: string, options?: ExecOptions) => Promise<{ stdout: string; stderr: string }> = promisify(execCallback);

// --- CONFIGURATION ---
const debug: boolean = false;
const debug_data: {
    videoURL: string;
    output: string[];
}[] = [];

const listUrl: string = "https://www.domestika.org/it/6bnxw6kzvs/courses_lists/4116171-ale";
const subtitle_lang: string = 'it';
const machine_os: 'mac' | 'win' = 'mac';

const cookiesFile: { name: string; value: string }[] = JSON.parse(
    fs.readFileSync('./cookies.json').toString()
);

const cookies: Cookie[] = [
    {
        name: '_domestika_session',
        value: cookiesFile.find((cookie) => cookie.name === '_domestika_session')?.value || '',
        domain: 'www.domestika.org',
        path: '/',
        expires: -1,
        size: 0,
        httpOnly: false,
        secure: true,
        session: false,
    },
];

// --- END CONFIGURATION ---

getAllCourses();

async function getAllCourses(): Promise<void> {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    await page.setCookie(...cookies);
    page.setDefaultNavigationTimeout(0);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['stylesheet', 'font', 'image'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    await page.goto(listUrl);
    const html: string = await page.content();
    const $ = cheerio.load(html);

    const coursesLinksEl = $('h3.o-course-card__title a');

    console.log(`${coursesLinksEl.length} Courses Detected`);

    const coursesLinks: string[] = coursesLinksEl.map((i, element) => $(element).attr('href') || '').get();
    const coursesTitles: string[] = coursesLinksEl.map((i, element) => $(element).text()).get();

    await Promise.all(
        coursesLinks.map((courseLink, index) => {
            console.log(`Scraping Course: ${coursesTitles[index]}`);
            return scrapeSite(`${courseLink}/course`);
        })
    );

    console.log('All Courses Downloaded');
    await browser.close();
}

async function scrapeSite(course_url: string): Promise<void> {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    await page.setCookie(...cookies);
    page.setDefaultNavigationTimeout(0);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['stylesheet', 'font', 'image'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    await page.goto(course_url);
    const html: string = await page.content();
    const $ = cheerio.load(html);

    console.log('Scraping Site');

    const allVideos: { title: string; videoData: { playbackURL: string; title: string; section: string }[] }[] = [];
    let units = $('h4.h2.unit-item__title a');
    const titleEl = $('h1.course-header-new__title').length
        ? $('h1.course-header-new__title')
        : $('.course-header-new__title-wrapper h1');
    const title: string = titleEl.text().trim().replace(/[/\\?%*:|"<>]/g, '-');

    const regex_final = /courses\/(.*?)-*\/final_project/gm;
    units = units.filter((i, element) => !regex_final.test($(element).attr('href') || ''));

    console.log(`${units.length} Units Detected`);

    for (let i = 0; i < units.length; i++) {
        const videoData = await getInitialProps($(units[i]).attr('href') || '', page);
        allVideos.push({
            title: $(units[i]).text().replaceAll('.', '').trim().replace(/[/\\?%*:|"<>]/g, '-'),
            videoData: videoData,
        });
    }

    console.log('All Videos Found');

    const downloadPromises = allVideos.flatMap((unit) =>
        unit.videoData.map((vData, a) => downloadVideo(vData, title, unit.title, a))
    );

    await Promise.all(downloadPromises);

    console.log(`Course downloaded: ${title}`);

    await page.close();
    await browser.close();

    if (debug) {
        fs.writeFileSync('log.json', JSON.stringify(debug_data));
        console.log('Log File Saved');
    }
}

async function getInitialProps(
    url: string,
    page: Page
): Promise<{ playbackURL: string; title: string; section: string }[]> {
    await page.goto(url);

    // @ts-ignore: Custom DOM structure
    const data = await page.evaluate(() => window.__INITIAL_PROPS__);
    const html: string = await page.content();
    const $ = cheerio.load(html);

    const section: string = $('h2.h3.course-header-new__subtitle')
        .text()
        .trim()
        .replace(/[/\\?%*:|"<>]/g, '-');

    const videoData: { playbackURL: string; title: string; section: string }[] = [];

    if (data?.videos?.length > 0) {
        for (const el of data.videos) {
            videoData.push({
                playbackURL: el.video.playbackURL,
                title: el.video.title.replaceAll('.', '').trim(),
                section: section,
            });
            console.log(`Video Found: ${el.video.title}`);
        }
    }

    return videoData;
}

async function downloadVideo(
    vData: { playbackURL: string; title: string; section: string },
    title: string,
    unitTitle: string,
    index: number
): Promise<void> {
    const directory = `domestika_courses/${title}/${vData.section}/${unitTitle}/`;

    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    const options = { maxBuffer: 1024 * 1024 * 10 };

    try {
        if (machine_os === 'win') {
            await exec(
                `N_m3u8DL-RE -sv res="1080*":codec=hvc1:for=best "${vData.playbackURL}" --save-dir "${directory}" --save-name "${index}_${vData.title.trimEnd()}"`,
                options
            );
            await exec(
                `N_m3u8DL-RE --auto-subtitle-fix --sub-format SRT --select-subtitle lang="${subtitle_lang}":for=all "${vData.playbackURL}" --save-dir "${directory}" --save-name "${index}_${vData.title.trimEnd()}"`,
                options
            );
        } else {
            await exec(
                `yt-dlp --output "${index}_${vData.title.trimEnd()}" --paths "${directory}" --sub-langs "en,${subtitle_lang}" --embed-subs "${vData.playbackURL}"`
            );
        }

        if (debug) {
            debug_data.push({
                videoURL: vData.playbackURL,
                output: [],
            });
        }
    } catch (error) {
        console.error(`Error downloading video: ${error}`);
    }
}
