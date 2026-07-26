import type { KitTemplate } from "./kit";

/**
 * Kit templates — the checklists themselves, authored by hand.
 *
 * This file is judgement, not data. There is no service that will tell you what
 * belongs in a go bag, and the lists that can be scraped are either affiliate
 * shopping pages or fantasy. So it is written the way tools/plants-curated.json
 * is written: a person decides what goes in and why, and the app's only job is
 * to turn that into something you can tick off, weigh, and put a date against.
 *
 * What is deliberately here:
 *
 *   * A `note` on nearly every line, and never a restatement of the name. A
 *     checklist that says "water filter" teaches nothing. One that says a
 *     hollow-fibre filter is destroyed by a single freeze, silently, and looks
 *     identical afterwards, changes what you do with it. The notes are the
 *     feature; the list is only the index into them.
 *
 *   * `rotateMonths` wherever a thing has a real shelf life, because rotation is
 *     what actually kills preparations. Nobody's store is defeated by the event.
 *     It is defeated by liquid bleach that lost a fifth of its strength every
 *     year, a power bank that self-discharged flat, and tinned tomatoes that ate
 *     through their own can. The numbers here are real shelf lives rather than
 *     round ones: liquid bleach is 6 months and granular pool shock is 10 years,
 *     and that single difference is why the household template recommends the
 *     granular form.
 *
 *   * Weights on every go-bag line, honest ones. A 72-hour bag is a weight
 *     budget before it is anything else, and it is the one template where the
 *     rollup is the point. As listed it comes to roughly 9 kg dry and 11 kg with
 *     water, which is already at the edge of what most people will carry uphill
 *     in bad weather. Anything you add has to displace something.
 *
 * Judgement calls worth knowing about:
 *
 *   * Quantities have an assumed scale. The go bag is one person for three days.
 *     The vehicle kit is one vehicle. The home template is sized for a household
 *     of four for thirty days and says so in its blurb, because "30 days" with
 *     no household size attached is the number that makes people store a tenth
 *     of what they need.
 *
 *   * Days of supply. Water is always litres, on a planning figure of 3 L per
 *     person per day for drinking and cooking — washing is on top of that and is
 *     the first thing to be cut. Food is person-days directly, with the physical
 *     quantity in the item name, because there is no honest way to add tins to
 *     kilos of rice to freeze-dried pouches; calories are the only common unit
 *     and days is how anyone actually thinks about them.
 *
 *   * `supply: "fuel"` means fuel that cooks and heats, measured in days. Petrol
 *     for a vehicle or a generator is capability rather than sustenance, so it
 *     carries its real quantity in litres and no supply tag, with the range or
 *     run-time in the note. Adding a jerry can to a stack of firewood would give
 *     a number that means nothing.
 *
 *   * Sanitation gets more lines than food in the home template. That is not an
 *     accident. In sieges, floods and long outages it is not hunger that fills
 *     the graves in the first month — it is faecal-oral disease in households
 *     that had food and water and nowhere to put their waste.
 *
 *   * The documents template stores nothing. It is a list of *places* — original
 *     in the fire safe, copy in the go bag, encrypted copy off-site — because
 *     the app has no business holding a scan of your passport, and because
 *     knowing where the third copy lives is the part people get wrong.
 *
 *   * Medication is described honestly, including where it cannot be stockpiled
 *     at all. Insulin needs a cold chain, several common drugs are dangerous to
 *     stop abruptly, and the right antibiotic depends on the infection. "Store a
 *     year of your medication" would be the most harmful sentence in this file.
 *
 *   * Nothing here tells you to acquire a weapon and nothing tells you not to.
 *     That is a legal question with a different answer in every jurisdiction the
 *     app runs in, and a checklist is the wrong place to have the argument.
 *
 * Weights and sizes are typical retail figures in metric, taken from things that
 * are actually sold. Where a number genuinely varies, the note says so instead
 * of the number pretending to a precision it does not have.
 */
export const KIT_TEMPLATES: KitTemplate[] = [
  // The only template with a weight budget, so every line carries `grams` and
  // the totals are meant to be uncomfortable. Water is two litres rather than
  // the nine that three days needs, because nine kilograms of water is the whole
  // load — the filter and the tablets are what make that survivable.
  {
    key: "go-bag-72h",
    name: "Go bag — 72 hours",
    blurb:
      "One person, on foot, for three days: the bag you pick up without thinking. Weight decides everything in it, because a bag left behind for being too heavy protects nobody.",
    sections: [
      {
        title: "Water & treatment",
        items: [
          {
            name: "Water bottles — 2 × 1 L",
            qty: 2,
            unit: "L",
            grams: 2100,
            note: "Plan 3 L per person per day for drinking and cooking, so 72 hours is 9 L and 9 kg. You carry two litres and treat the rest as you go, which is why the filter below is not optional.",
            supply: "water",
            rotateMonths: 6,
          },
          {
            name: "Hollow-fibre squeeze filter",
            grams: 90,
            note: "Rated for thousands of litres, but one freeze cracks the fibres and it then passes everything while looking exactly the same. Keep it inside your jacket below zero and blow it dry after use.",
          },
          {
            name: "Chlorine dioxide tablets — 30",
            qty: 30,
            perPerson: true,
            unit: "tablets",
            grams: 30,
            note: "The backup for a clogged or frozen filter, and the only thing here that deals with viruses. Cold or cloudy water needs four hours, not the 30 minutes on the packet.",
            rotateMonths: 48,
          },
          {
            name: "Collapsible 2 L dirty-water bladder",
            grams: 45,
            note: "Lets you filter sitting at camp instead of crouching in a creek, and empty it weighs nothing. That is the entire argument for it.",
          },
          {
            name: "Stainless cup, 750 ml, single wall",
            grams: 130,
            note: "Single wall only — a double-walled cup cannot go on a fire. Boiling is the one treatment that needs no consumable and cannot expire.",
          },
        ],
      },
      {
        title: "Food",
        items: [
          {
            name: "Freeze-dried meal pouches × 3",
            qty: 1,
            unit: "days",
            grams: 480,
            note: "One hot dinner a night at about 800 kcal each. Each needs 500 ml of boiling water, which is a real cost when water is the constraint; cold soaking works but takes an hour.",
            supply: "food",
            rotateMonths: 60,
          },
          {
            name: "Energy bars × 9",
            qty: 1,
            unit: "days",
            grams: 630,
            note: "Breakfast and lunch, eaten walking. Choose ones you have actually eaten at home — a bar you dislike is one you will not finish when you are cold and stressed.",
            supply: "food",
            rotateMonths: 12,
          },
          {
            name: "Nut butter and trail mix — 400 g",
            qty: 1,
            unit: "days",
            grams: 400,
            note: "Fat is the most calories you can carry per gram, about 9 kcal against 4 for sugar. It also goes rancid faster than anything else in the bag — smell it, do not trust the date.",
            supply: "food",
            rotateMonths: 6,
          },
          {
            name: "Electrolyte sachets × 6",
            qty: 6,
            perPerson: true,
            unit: "sachets",
            grams: 60,
            note: "A headache and cramp on day two is usually salt rather than water. Weightless, and the difference between walking and sitting down.",
            rotateMonths: 36,
          },
          {
            name: "Long spoon",
            grams: 15,
            note: "Long enough to reach the bottom of a pouch without wearing the contents on your knuckles.",
          },
        ],
      },
      {
        title: "Shelter & warmth",
        items: [
          {
            name: "Tarp, 3 × 3 m, with guylines",
            grams: 700,
            note: "Faster to pitch than a tent, works off two trees or one pole, and doubles as a rain catch. Silnylon over cheap polyurethane, whose coating delaminates within a couple of seasons.",
          },
          {
            name: "Sleeping bag or quilt, 5 °C comfort",
            grams: 900,
            note: "Read the comfort rating, not the limit rating — the limit figure is the temperature at which an average man survives a night shivering, not sleeps through one.",
          },
          {
            name: "Closed-cell foam mat, three-quarter length",
            grams: 250,
            note: "Insulation underneath matters more than the bag on top, because the ground takes heat far faster than air does. Foam cannot puncture, which is why it beats an inflatable here.",
          },
          {
            name: "Emergency bivvy bag",
            grams: 120,
            note: "A bag you get inside, not a sheet the wind opens. The thin foil blankets tear the first night and are worth carrying only as a spare.",
          },
          {
            name: "Paracord, 15 m",
            grams: 130,
            note: "Ridge line, guylines, replacement bootlace, splint ties. The seven inner strands of 550 cord are usable cordage on their own, which is why 15 m goes a long way.",
          },
          {
            name: "Contractor bags × 2",
            grams: 80,
            note: "Pack liner, water carrier, poncho, ground sheet, casualty wrap. The heavy gauge — kitchen bin liners split the first time you fill one.",
          },
        ],
      },
      {
        title: "Fire",
        items: [
          {
            name: "Lighters × 2",
            qty: 2,
            unit: "lighters",
            grams: 45,
            note: "One in the bag, one on your body. They fail cold and they fail wet, so warm one inside your jacket before you rely on it near freezing or high up.",
            rotateMonths: 24,
          },
          {
            name: "Ferrocerium rod, 5 mm",
            grams: 45,
            note: "Works soaked and works frozen, which the lighter does not. It needs finer tinder than a flame does, so it is a skill rather than a backup you can leave untested.",
          },
          {
            name: "Stormproof matches × 20, in a waterproof case",
            qty: 20,
            unit: "matches",
            grams: 60,
            note: "The case matters more than the matches. Ordinary matches loose in a damp bag are decoration.",
            rotateMonths: 60,
          },
          {
            name: "Tinder — cotton pads soaked in petroleum jelly × 6",
            qty: 6,
            unit: "pads",
            grams: 40,
            note: "Each burns three or four minutes, which is what wet kindling actually needs. Free to make and better than anything sold as tinder.",
          },
          {
            name: "Canister stove and 100 g gas",
            qty: 3,
            unit: "days",
            grams: 340,
            note: "A 100 g canister boils roughly 8 litres — three days of meals and hot drinks with nothing spare. In winter it is half that, and the canister has to sleep in the bag with you or it will not light.",
            supply: "fuel",
          },
        ],
      },
      {
        title: "Light",
        items: [
          {
            name: "Head torch, 300 lm",
            grams: 95,
            note: "Hands free is the entire point: a hand torch means you cannot pitch a tarp in the dark. Pick one that takes the same cell as everything else you carry.",
          },
          {
            name: "Spare cells — one full set",
            grams: 35,
            note: "Lithium primaries rather than alkaline. They weigh less, work in cold, and do not leak inside the torch and destroy it. Store them outside the torch so nothing drains them.",
            rotateMonths: 120,
          },
          {
            name: "Chemical light sticks × 2",
            qty: 2,
            unit: "sticks",
            grams: 30,
            note: "No battery and no switch to fail, and they will not wreck your night vision. For marking a turning or a casualty, not for reading.",
            rotateMonths: 48,
          },
          {
            name: "Small backup torch",
            grams: 40,
            note: "The head torch is the one that gets dropped in a river. This one lives in a pocket and never comes out otherwise.",
          },
        ],
      },
      {
        title: "Navigation",
        items: [
          {
            name: "Paper map of your area, 1:50,000, in a map case",
            grams: 90,
            note: "Printed and marked with your rally points before you needed it — the Plan panel prints one. A phone map you cannot charge is not a map.",
          },
          {
            name: "Baseplate compass with adjustable declination",
            grams: 40,
            note: "Setting the local offset once beats doing arithmetic with cold hands every time. A button compass gives you a rough direction and nothing else.",
          },
          {
            name: "Pencil and waterproof notebook",
            grams: 60,
            note: "Bearings, times, water sources, who you met and where. You will not remember day one on day three.",
          },
          {
            name: "Whistle",
            grams: 10,
            note: "Three blasts is distress. It carries far past a shout and it does not cost you your voice.",
          },
          {
            name: "Watch with a second hand",
            grams: 50,
            note: "Timing a boil, a tourniquet, a pace count or a leg of a bearing. Anything that runs your phone battery down to tell the time is the wrong tool.",
            rotateMonths: 24,
          },
        ],
      },
      {
        title: "First aid",
        items: [
          {
            name: "Tourniquet — CAT or SOFTT-W",
            grams: 90,
            note: "The one item here that stops a death in minutes. Buy a real one; the half-price copies snap at the windlass, which you discover with a hand on an artery. Practise one-handed on yourself until it is boring.",
            rotateMonths: 60,
          },
          {
            name: "Pressure bandage",
            grams: 90,
            note: "Dressing, pressure bar and wrap in one, and it can be put on one-handed. The date on it is about the sterility of the pad, not the fabric.",
            rotateMonths: 60,
          },
          {
            name: "Haemostatic gauze",
            grams: 40,
            note: "For bleeding a tourniquet cannot reach — neck, armpit, groin. Pack it hard into the wound and hold pressure for three minutes by the watch.",
            rotateMonths: 48,
          },
          {
            name: "Wound kit — gauze, tape, plasters, antiseptic wipes",
            grams: 180,
            note: "Blisters and small cuts are what you will actually open it for. Over three days the realistic threat is infection, not trauma.",
            rotateMonths: 36,
          },
          {
            name: "Nitrile gloves × 2 pairs",
            qty: 2,
            perPerson: true,
            unit: "pairs",
            grams: 20,
            note: "Nitrile rather than latex: latex perishes in a hot bag and some people react badly to it.",
            rotateMonths: 60,
          },
          {
            name: "Painkillers, antihistamine, loperamide, rehydration salts",
            grams: 80,
            note: "Diarrhoea is the illness that will actually stop you, because it costs water you cannot spare. The rehydration salts matter more than the painkillers.",
            rotateMonths: 36,
          },
          {
            name: "Personal medication — 7 days",
            qty: 7,
            perPerson: true,
            unit: "days",
            grams: 60,
            note: "Seven days rather than three, because 72 hours is a hope and not a guarantee. Rotate it against your repeat prescription so the bag never holds the old bottle.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Tools",
        items: [
          {
            name: "Fixed-blade knife, 100 mm",
            grams: 200,
            note: "Fixed blade over folder: no hinge to fail and nothing to trap dirt. Full tang. It is a work tool, and it will spend its life on cordage, food and firewood.",
          },
          {
            name: "Multi-tool with pliers",
            grams: 200,
            note: "The pliers are the reason to carry it — gripping and twisting is the one thing a knife cannot do. Everything else on it is a bonus.",
          },
          {
            name: "Sharpening stone or ceramic rod",
            grams: 60,
            note: "A blunt knife needs more force and cuts you instead of the wood. Three days of real use will blunt one.",
          },
          {
            name: "Duct tape — 5 m wrapped round a bottle",
            grams: 60,
            note: "Wrapped rather than a roll, because the cardboard core is most of the weight. The adhesive dries out after a few years in a hot bag, so re-wrap it when you rotate.",
            rotateMonths: 60,
          },
          {
            name: "Repair kit — needle, heavy thread, spare buckle, fabric tape",
            grams: 50,
            note: "A snapped hip belt turns a carried load into a dragged one, and the buckle is the part that breaks.",
          },
          {
            name: "Folding saw",
            grams: 180,
            note: "Firewood is a saw job. Batoning through a log is how a knife ends up in two pieces. Leave it behind in country with no wood.",
          },
        ],
      },
      {
        title: "Documents & cash",
        items: [
          {
            name: "Cash in small notes",
            grams: 40,
            note: "Small denominations, because nobody will have change and a large note marks you as worth following. Cards stop working with the network, not with the crisis.",
          },
          {
            name: "Copies of ID, insurance and prescriptions, sealed",
            grams: 40,
            note: "Paper, in a sealed bag. Check them yearly — expired documents and superseded prescriptions are exactly what you will be holding otherwise.",
            rotateMonths: 12,
          },
          {
            name: "Written contact list and rally points",
            grams: 15,
            note: "Your phone knows the numbers you do not. Include the out-of-area contact everyone in the family calls when local networks are saturated.",
            rotateMonths: 12,
          },
          {
            name: "Encrypted USB stick",
            grams: 15,
            note: "The same scans plus family photographs. Encrypted, because bags are lost and taken. Where the other copies live is the Documents kit.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Comms",
        items: [
          {
            name: "Phone and charging cable",
            grams: 220,
            note: "Still your best camera, notebook and offline map. Aeroplane mode turns one day of battery into three.",
          },
          {
            name: "Power bank, 10,000 mAh",
            grams: 200,
            note: "Two phone charges and no more. Top it up every three months: lithium cells self-discharge, and one left flat for a year is dead rather than low.",
            rotateMonths: 3,
          },
          {
            name: "Handheld radio, already programmed",
            grams: 250,
            note: "Only worth carrying if the people you want to reach have one and it is already set to the same channel. An untested radio in a bag is ballast.",
            rotateMonths: 6,
          },
          {
            name: "Frequency card",
            grams: 5,
            note: "Channels, tones and the times your group listens, on paper. Stress takes memory first, and a radio that resets itself takes the rest.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Hygiene",
        items: [
          {
            name: "Toothbrush, small toothpaste, soap",
            grams: 90,
            note: "Morale, and a genuine infection risk over a week. Trivial weight for both.",
          },
          {
            name: "Hand sanitiser, 50 ml",
            grams: 60,
            note: "For before you eat and after you deal with waste. Alcohol evaporates through the bottle, so an old one is scented water.",
            rotateMonths: 36,
          },
          {
            name: "Toilet paper, flattened, and a trowel",
            grams: 120,
            note: "Bury waste 15–20 cm deep and at least 60 m from water. This is the sanitation half of a three-day bag and it is the half people leave out.",
          },
          {
            name: "Wet wipes × 20",
            qty: 20,
            perPerson: true,
            unit: "wipes",
            grams: 130,
            note: "A wash when there is no water to spare. They dry out in the packet, so check the seal every time you rotate the bag.",
            rotateMonths: 24,
          },
          {
            name: "Menstrual supplies",
            grams: 100,
            note: "Pack them whether or not you expect to need them. A month's worth weighs nothing and cannot be improvised well.",
            rotateMonths: 60,
          },
        ],
      },
      {
        title: "Clothing",
        items: [
          {
            name: "Waterproof jacket with a hood",
            grams: 350,
            note: "Wind and rain at 8 °C kills people that dry cold at −10 °C does not. Taped seams and a hood that stays up in wind.",
          },
          {
            name: "Insulating layer — synthetic",
            grams: 400,
            note: "Synthetic rather than down. Down is warmer per gram and worthless once wet, and you have no way to dry it out here.",
          },
          {
            name: "Spare socks × 2 pairs",
            qty: 2,
            perPerson: true,
            unit: "pairs",
            grams: 160,
            note: "Dry feet are a mobility problem, not a comfort one. Change at midday and dry the wet pair against your body while you walk.",
          },
          {
            name: "Hat and gloves",
            grams: 130,
            note: "Thin liner gloves you can work in beat thick ones you have to take off. The hat is the cheapest warmth you own.",
          },
          {
            name: "Sun hat and sunglasses",
            grams: 90,
            note: "Snow and water double the dose. Snow blindness is a day of being unable to walk, and it arrives hours after the damage is done.",
          },
          {
            name: "Sunscreen and lip balm",
            grams: 90,
            note: "The UV filters break down, so expired sunscreen is just moisturiser. Lips crack first in wind and at altitude.",
            rotateMonths: 36,
          },
          {
            name: "Buff or neck gaiter",
            grams: 40,
            note: "Dust mask, hat, pot holder, sweatband, eye cover for sleeping in daylight. Nothing else does five jobs for 40 grams.",
          },
          {
            name: "Boots you have already walked in",
            grams: 0,
            note: "Worn rather than carried, which is the only reason they are free here. New boots on day one is how you get blisters that stop you walking on day two.",
          },
        ],
      },
    ],
  },

  // The vehicle carries weight a person never could, so nothing here is chosen
  // for mass. It is chosen for the two failure modes: the car that will not move
  // and the night you spend sitting in it.
  {
    key: "vehicle-kit",
    name: "Vehicle kit",
    blurb:
      "Lives in the boot and stays there. Half of it gets you moving again; the other half gets you through a night in a car that is not going anywhere.",
    sections: [
      {
        title: "Recovery & traction",
        items: [
          {
            name: "Tow strap, 5 m, rated above twice the vehicle weight",
            note: "A rated recovery strap, not a rope with hooks on the end — a hook that lets go comes back through a windscreen. Attach to rated recovery points, never to a tow ball.",
          },
          {
            name: "Soft shackles or rated bow shackles × 2",
            qty: 2,
            unit: "shackles",
            note: "The strap is only as strong as what joins it to the car. Soft shackles weigh nothing and cannot become a missile.",
          },
          {
            name: "Traction boards, or a bag of grit and sand",
            note: "Most stuck is twenty centimetres of mud or snow. Boards under the driven wheels beat the winch you do not own.",
          },
          {
            name: "Folding shovel",
            note: "For digging out a wheel and, in snow, for clearing the exhaust. A buried tailpipe fills the cabin with carbon monoxide while you sit and wait for help.",
          },
          {
            name: "Snow chains or textile socks",
            note: "Fit them once on your own driveway in daylight. Nobody works out chains for the first time on a hill in the dark with traffic behind them.",
          },
        ],
      },
      {
        title: "Spares & repair",
        items: [
          {
            name: "Full-size spare wheel, pressure checked",
            note: "Check its pressure whenever you check the others — a flat spare is the most common failure on this whole list. A space-saver means 80 km at 80 km/h and then nothing.",
            rotateMonths: 6,
          },
          {
            name: "Tyre plug kit and a 12 V compressor",
            note: "Plugs a tread puncture in ten minutes without taking the wheel off. It does nothing at all for a sidewall, which is a wheel change and no argument.",
          },
          {
            name: "Jack, wheel brace and a flat board",
            note: "The factory jack sinks into soft ground and mud. The board is the part everybody leaves out and the part that decides whether the jack works.",
          },
          {
            name: "Fan belt, top and bottom hoses, clips, fuses",
            note: "Matched to your engine, bought once, never opened. A blown fuel-pump fuse strands you exactly as completely as a seized engine and costs pennies.",
          },
          {
            name: "Self-amalgamating tape",
            note: "Gets a split coolant hose home. It fuses to itself rather than sticking to anything, so it works hot, wet and oily where tape does not.",
            rotateMonths: 60,
          },
          {
            name: "Jubilee clips, zip ties, baling wire",
            note: "Almost every roadside repair is holding something back where it used to be until you reach a workshop.",
          },
          {
            name: "Spare bulbs and wiper blades",
            note: "Cheap, and both are the difference between driving at night in rain and stopping for it.",
            rotateMonths: 24,
          },
        ],
      },
      {
        title: "Fuel & fluids",
        items: [
          {
            name: "Petrol — 20 L in a metal jerry can",
            qty: 20,
            unit: "L",
            note: "Roughly 200 km in a loaded vehicle: one tankful of second chances. Untreated petrol goes stale in three to six months and stale petrol will not start a cold engine, so pour it into the tank each spring and refill the can.",
            rotateMonths: 6,
          },
          {
            name: "Fuel stabiliser",
            note: "Turns three months of usable petrol into a year, which is the difference between a can you rotate twice a year and a can you forget about entirely.",
            rotateMonths: 24,
          },
          {
            name: "Engine oil — 1 L of the correct grade",
            note: "Sealed oil keeps for years. Losing oil slowly is a repair; running the engine dry is a new engine.",
            rotateMonths: 60,
          },
          {
            name: "Pre-mixed coolant, 2 L",
            note: "Pre-mixed, so you do not need clean water to dilute it at the roadside. Plain water gets you home in August and cracks the block in January.",
            rotateMonths: 24,
          },
          {
            name: "Screenwash concentrate",
            note: "A windscreen filmed with salt or dust is genuinely blinding into low sun, and that is when most people are driving home.",
            rotateMonths: 60,
          },
          {
            name: "Funnel and 2 m of clear hose",
            note: "For moving your own fuel between vehicles and cans without swallowing any. Never siphon by mouth.",
          },
        ],
      },
      {
        title: "Power & charging",
        items: [
          {
            name: "Lithium jump pack",
            note: "Recharge it twice a year or it will be flat on the first cold morning of the winter. It revives a flat battery, not a shorted one — a battery that boils or smells of sulphur is finished.",
            rotateMonths: 6,
          },
          {
            name: "Jump leads, heavy gauge",
            note: "Thin petrol-station leads will not turn a cold diesel. Carry them alongside the pack, because leads work at any temperature and never need charging themselves.",
          },
          {
            name: "12 V to USB adapter and cables",
            note: "The accessory socket usually stays live long after the battery has stopped being able to turn the starter.",
          },
          {
            name: "Inverter, 150 W",
            note: "For a laptop or a radio charger. Nothing with a heating element will run from a cigarette socket, so it is not a kettle and never will be.",
          },
          {
            name: "Spare AA and AAA lithium cells",
            note: "A boot in summer reaches 60 °C, which destroys alkaline cells and makes them leak inside whatever they are in. Lithium primaries survive it.",
            rotateMonths: 120,
          },
        ],
      },
      {
        title: "Warmth & shelter",
        items: [
          {
            name: "Wool blankets × 2",
            qty: 2,
            perPerson: true,
            unit: "blankets",
            note: "Warm when damp and they will not melt near a flame. Two, so one goes underneath you — a car seat pulls heat out of you all night.",
          },
          {
            name: "Sleeping bag per seat",
            note: "A stopped car in winter reaches outside temperature within an hour. Running the engine for heat costs a litre an hour and kills people whose exhaust is in a snowdrift.",
          },
          {
            name: "Hats, gloves and spare coats",
            note: "Whatever you were wearing when you set off is what you have. People break down dressed for a heated cabin and a car park at the other end.",
          },
          {
            name: "Tarp and paracord",
            note: "Shade in summer, a windbreak in winter, and somewhere dry to lie while you work under the vehicle.",
          },
          {
            name: "Candle lantern or tea lights in a tin",
            note: "One candle lifts a car interior several degrees for hours and is far safer than idling the engine. Crack a window anyway.",
            rotateMonths: 60,
          },
        ],
      },
      {
        title: "Water & food",
        items: [
          {
            name: "Water — 20 L in the boot",
            qty: 20,
            unit: "L",
            note: "At 3 L per person per day that is a day and a half for a family, or a radiator top-up, or enough to flush out an eye. Rotate every six months: stored water goes flat and tastes of the container long before it becomes unsafe.",
            supply: "water",
            rotateMonths: 6,
          },
          {
            name: "Bottled water in the doors — 4 × 500 ml",
            qty: 2,
            unit: "L",
            note: "Reachable without getting out or unloading. Leave headroom in each bottle, because a hard frost splits a full one.",
            supply: "water",
            rotateMonths: 12,
          },
          {
            name: "Food that survives a hot boot — 3 person-days",
            qty: 3,
            unit: "days",
            note: "A boot hits 60 °C in summer, which destroys chocolate, most cereal bars and anything with much fat in it. Boiled sweets, plain biscuits and tinned food come through it.",
            supply: "food",
            rotateMonths: 12,
          },
          {
            name: "Water filter or treatment tablets",
            note: "So a stream or a tap of doubtful provenance extends the 20 L instead of replacing it.",
            rotateMonths: 48,
          },
        ],
      },
      {
        title: "Navigation",
        items: [
          {
            name: "Current paper road atlas",
            note: "Roads change slowly and atlases are cheap. This is the one that still works with a dead phone, a closed motorway and a diversion onto lanes.",
            rotateMonths: 60,
          },
          {
            name: "Printed local map at 1:50,000",
            note: "For the last few kilometres on foot when the road is blocked. Print it from the Plan panel with your rally points already marked.",
          },
          {
            name: "Compass",
            note: "Kept in the vehicle but used outside it — the steel body and the speakers throw a needle off by tens of degrees. Walk away from the car before you trust it.",
          },
        ],
      },
      {
        title: "Tools",
        items: [
          {
            name: "Sockets, spanners, screwdrivers, pliers",
            note: "Sized to match the vehicle. A tool that does not fit anything on your car is weight you have carried for years.",
          },
          {
            name: "Head torch and a hand torch",
            note: "Both: the head torch to work by, the hand torch to hand to somebody else or to wave at traffic.",
          },
          {
            name: "Work gloves",
            note: "Hot manifolds, sharp bodywork, frozen steel. None of this is possible with numb or cut hands.",
          },
          {
            name: "Seatbelt cutter and window breaker",
            note: "On the visor or the buckle, within reach of the belted driver. In the boot it is an ornament.",
          },
          {
            name: "Fire extinguisher, 1 kg dry powder",
            note: "Mounted where you can reach it while belted in. Check the gauge yearly and invert it so the powder does not cake into a solid lump.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Visibility & safety",
        items: [
          {
            name: "Warning triangle and hi-vis vests",
            note: "Required by law across much of Europe, and the reason you are not hit while changing a wheel. The vest goes on before you open the door, not after.",
          },
          {
            name: "LED beacons or road flares",
            note: "LED rather than pyrotechnic anywhere fuel might be spilled. Flares have a real expiry and fail once damp.",
            rotateMonths: 48,
          },
          {
            name: "First aid and trauma kit — see the Medical kit",
            note: "The vehicle is where the trauma kit belongs, because a road collision is the most serious injury most people will ever attend.",
          },
          {
            name: "Carbon monoxide alarm",
            note: "For anyone who might sleep in the vehicle with the engine or a heater running. The sensor itself expires after a few years whether or not it has ever alarmed.",
            rotateMonths: 60,
          },
          {
            name: "Written note of your route and expected arrival",
            note: "Left with somebody, before you leave. Search starts far sooner for a person who is overdue on a known route than for one who simply stopped answering.",
          },
        ],
      },
    ],
  },

  // Sized for a household of four for thirty days, and written so the same list
  // scales to a year by multiplying. Sanitation is the longest section on
  // purpose — see the note at the top of this file.
  {
    key: "home-30d",
    // The quantities below are written for four people for thirty days, so a
    // household of any other size scales from four, not from one.
    basePeople: 4,
    name: "Home — 30 days to a year",
    blurb:
      "Sheltering in place, where weight stops mattering and rotation starts. Quantities are for a household of four for thirty days; multiply by the people and the months you are actually planning for.",
    sections: [
      {
        title: "Water — storage & treatment",
        items: [
          {
            name: "Food-grade drums — 2 × 200 L",
            qty: 400,
            unit: "L",
            note: "Four people for thirty days is 360 L at the 3 L per person per day planning figure, which is why drums are the only realistic answer. Blue HDPE keeps the light out and the algae with it. Full, they weigh 400 kg — put them on a ground-floor slab, never on a suspended floor.",
            supply: "water",
            rotateMonths: 12,
          },
          {
            name: "Stackable containers — 6 × 20 L",
            qty: 120,
            unit: "L",
            note: "The share you can move. A 200 L drum cannot be carried, shared or taken with you; 20 L is 20 kg and about as much as one person shifts any distance.",
            supply: "water",
            rotateMonths: 12,
          },
          {
            name: "Bath and every container filled at the first warning",
            note: "A bath is 150 L and costs nothing if you fill it while the mains still has pressure. The moment is when you hear the warning, not when the taps run dry.",
          },
          {
            name: "Calcium hypochlorite granules (pool shock), 500 g",
            note: "Keeps for a decade against six months for the liquid, which at household scale is the whole argument. Half a kilo treats thousands of litres. Mix a solution only as you need it and never store the solution.",
            rotateMonths: 120,
          },
          {
            name: "Unscented household bleach, 5 L",
            note: "Loses roughly a fifth of its strength a year, faster in a warm cupboard, and after a year you can no longer dose with it accurately. Plain sodium hypochlorite only — no scent, no thickener, no detergent.",
            rotateMonths: 6,
          },
          {
            name: "Water treatment tablets — 200",
            qty: 200,
            perPerson: true,
            unit: "tablets",
            note: "The per-bottle answer, for water carried in rather than water in a drum. Chlorine dioxide deals with cryptosporidium; ordinary chlorine does not.",
            rotateMonths: 48,
          },
          {
            name: "Gravity filter, 8–12 L/hour, with spare elements",
            note: "The household workhorse: dirty in the top, clean out the bottom, no pumping and no power. Buy the spare elements now, because they are the part that becomes unobtainable.",
            rotateMonths: 60,
          },
          {
            name: "Rain barrel and roof diverter",
            note: "Roof water carries bird droppings and whatever the tiles hold, so it is input to the filter rather than drinking water. Divert the first few minutes of any storm to waste.",
          },
          {
            name: "Stockpot, 15 L, for boiling",
            note: "Boiling needs no consumable and cannot expire: a rolling boil for one minute, three above 2,000 m. It is the treatment that still works when everything else on this list has run out.",
          },
        ],
      },
      {
        title: "Food stores & rotation",
        items: [
          {
            name: "White rice — 25 kg, sealed with oxygen absorbers",
            qty: 45,
            unit: "days",
            note: "White rather than brown: the oil in the bran turns rancid within six months while white rice keeps for decades sealed. Around 89,000 kcal, and useless on its own without fat and salt.",
            supply: "food",
            rotateMonths: 120,
          },
          {
            name: "Dried beans and lentils — 15 kg",
            qty: 25,
            unit: "days",
            note: "The protein that makes the rice a meal. Old beans stay safe but stop softening, and after five years they need a pressure cooker and fuel you may not have. Lentils never develop the problem, so make some of it lentils.",
            supply: "food",
            rotateMonths: 60,
          },
          {
            name: "Tinned meat and fish — 60 tins",
            qty: 20,
            unit: "days",
            note: "Fat, protein and salt in a form that needs no cooking and no water. Tins fail at the seam and at the rim, so anything dented on the seam gets eaten this week.",
            supply: "food",
            rotateMonths: 48,
          },
          {
            name: "Tinned vegetables and fruit — 80 tins",
            qty: 15,
            unit: "days",
            note: "Tomatoes and anything acidic corrode the can from the inside and are finished in eighteen months; plain vegetables last three years. Write the date on the lid in marker as it comes into the house, because the printed one is where you cannot read it on a shelf.",
            supply: "food",
            rotateMonths: 30,
          },
          {
            name: "Cooking oil — 10 L",
            qty: 20,
            unit: "days",
            note: "Fat is the hardest thing to get out of a stored diet and the first thing in it to spoil. Buy small bottles rather than one drum: an opened drum oxidises long before a household finishes it.",
            supply: "food",
            rotateMonths: 18,
          },
          {
            name: "Rolled oats — 10 kg",
            qty: 20,
            unit: "days",
            note: "Breakfast that needs only hot water, and it will be eaten by people who refuse everything else. The oil in the germ caps it at about two years even sealed.",
            supply: "food",
            rotateMonths: 24,
          },
          {
            name: "Freeze-dried pouches — a 30-day supply",
            qty: 30,
            unit: "days",
            note: "Expensive per calorie, and worth it for the part of the store you never touch or rotate. The twenty-five-year claim assumes an unopened tin kept cool — a garage that reaches 40 °C in summer roughly halves it.",
            supply: "food",
            rotateMonths: 240,
          },
          {
            name: "Salt — 5 kg",
            note: "Does not expire, ever, and cannot be made inland. Preserving, electrolytes, and making dull food edible enough that people keep eating it — which is a real failure mode by week three.",
          },
          {
            name: "Sugar and honey",
            note: "Dry sugar keeps indefinitely and honey does not spoil at all. Calories, preserving, and the only sweetness anyone will see for a month.",
          },
          {
            name: "Multivitamins",
            note: "A stored-food diet runs short of vitamins A and C long before it runs short of calories. Cheap insurance against the deficiency diseases that used to define a siege.",
            rotateMonths: 24,
          },
          {
            name: "Coffee, tea, chocolate, spices",
            note: "Morale is not a luxury at week three, and this is also the best barter stock in the house.",
            rotateMonths: 24,
          },
          {
            name: "Food for pets, infants and anyone on a special diet",
            note: "None of it can be improvised and none of it can wait. Infant formula in particular has a short date and no substitute worth the risk.",
            rotateMonths: 12,
          },
          {
            name: "Written stock list with dates, kept on the shelf",
            note: "The food above adds to about 175 person-days — four people for six weeks, with margin because nobody eats rice seven days a week. Rotation is what actually kills a store: first in, first out, checked twice a year, or in five years you own a pallet of rubbish.",
            rotateMonths: 6,
          },
        ],
      },
      {
        title: "Cooking & heat without power",
        items: [
          {
            name: "Propane cylinders — 2 × 13 kg",
            qty: 45,
            unit: "days",
            note: "A 13 kg cylinder is three to four weeks of cooking for a family. The gas itself never goes off; the valve and the hose do, so check the seals and replace the hose every five years.",
            supply: "fuel",
            rotateMonths: 60,
          },
          {
            name: "Seasoned firewood — 2 m³",
            qty: 60,
            unit: "days",
            note: "Seasoned means under 20 per cent moisture. Green wood gives half the heat and lines the chimney with tar that later catches fire. Two years ahead is the traditional stack for exactly that reason.",
            supply: "fuel",
          },
          {
            name: "Two-burner propane stove, outdoor rated",
            note: "Outdoors or in an open doorway, always. Every year people die cooking indoors on camping equipment, and carbon monoxide gives no warning of any kind.",
          },
          {
            name: "Rocket stove or efficient wood burner",
            note: "Cooks a meal on a double handful of twigs, which matters enormously when the same wood pile has to heat the house all winter.",
          },
          {
            name: "Wood stove or fireplace, swept",
            note: "Swept yearly if you burn regularly. A chimney fire during a grid outage, with no fire service coming, is the worst version of that day.",
            rotateMonths: 12,
          },
          {
            name: "Carbon monoxide alarms, one per floor",
            note: "The highest-value item in this section by a distance. The sensor expires on a date printed on the back whether or not it has ever sounded — that date, not the battery, is what you check.",
            rotateMonths: 60,
          },
          {
            name: "Fire extinguishers and a fire blanket",
            note: "You are about to cook and heat with open flame in a house designed for neither. One in the kitchen within reach of the door, not behind the stove.",
            rotateMonths: 12,
          },
          {
            name: "Matches, lighters and a ferrocerium rod",
            note: "Boxes of matches rather than a novelty tin, kept dry and split between two places in the house so one leak does not take all of it.",
            rotateMonths: 60,
          },
          {
            name: "Thermal curtains, draught excluders, plastic sheeting",
            note: "Heat one room and close the rest of the house off. Insulating what you have is far cheaper than burning fuel to replace what leaks out of it.",
          },
        ],
      },
      {
        title: "Sanitation",
        items: [
          {
            name: "Bucket toilet — 20 L bucket, snap-on seat, heavy liners",
            note: "When the mains stops, the toilet stops, and this is the single most likely thing to make your household ill. Two buckets, so one is in use while the other is being emptied, and heavy-gauge liners because a split bag indoors is a disaster you cannot undo.",
            rotateMonths: 60,
          },
          {
            name: "Cover material — sawdust, wood ash, dry soil or peat",
            note: "A scoop after every use is what stops the smell and breaks the fly cycle. It has to be dry, and you need roughly the same volume going in as comes out, which is far more than people expect.",
          },
          {
            name: "Separate container for urine",
            note: "Keeping urine out of the solids is the whole trick. Together they go anaerobic and stink within a day; apart, both are nearly manageable. Urine can go on the ground away from anything you eat, or on plants diluted ten to one.",
          },
          {
            name: "Latrine site chosen in advance",
            note: "Downhill and at least 30 m from any well or water you drink, and not somewhere the water table is a spade deep. Decide it in daylight, dry, before anybody is desperate.",
          },
          {
            name: "Hydrated or garden lime — 10 kg",
            note: "Sprinkled into a latrine it raises the pH, kills the smell and stops flies breeding. It absorbs carbon dioxide from the air and reverts to chalk in an open bag, so keep it sealed.",
            rotateMonths: 24,
          },
          {
            name: "Heavy-duty rubble sacks — 100",
            qty: 100,
            perPerson: true,
            unit: "sacks",
            note: "Double-bagged waste, stored well away from the house until it can be buried or collected. Ordinary bin bags split under the weight and you only learn that indoors.",
            rotateMonths: 60,
          },
          {
            name: "Bar soap — 20 bars",
            qty: 20,
            perPerson: true,
            unit: "bars",
            note: "Handwashing after the toilet and before food is the single intervention that prevents dysentery. Not sanitiser, which does nothing against norovirus and nothing at all on dirty hands. Bar soap keeps for years and barters well.",
          },
          {
            name: "Handwashing station — a tap-fitted jerry can or tippy tap",
            note: "Running water, however little of it. Washing in a shared bowl spreads precisely what you are trying to stop.",
          },
          {
            name: "Bleach and a dedicated surface-cleaning kit",
            note: "Kept physically apart from the water treatment, so nobody ever confuses a cleaning bottle with a dosing bottle. Label both.",
            rotateMonths: 6,
          },
          {
            name: "Nappies, menstrual and incontinence supplies",
            note: "Reusable versions save the stockpile but need water and soap to launder, so plan for both. This is the supply people are most embarrassed to ask about and most desperate without.",
            rotateMonths: 60,
          },
          {
            name: "Waste plan — where a month of household rubbish goes",
            note: "What burns, what gets buried, and what has to be stored. Rats arrive within about a week of collections stopping, and they come indoors.",
          },
          {
            name: "Greywater plan — washing, laundry and where it drains",
            note: "Washing water is on top of the 3 L a day for drinking, and it is the first thing to be cut. Reused sensibly it flushes the toilet; poured out of a back door for a month it makes a swamp against the wall.",
          },
        ],
      },
      {
        title: "Medical",
        items: [
          {
            name: "Household first aid stores — see the Medical kit",
            note: "This section lists what a house needs on top of that kit; the trauma and wound detail lives there rather than being repeated here.",
          },
          {
            name: "Prescription medication — the longest supply your prescriber will write",
            note: "Ask at every repeat rather than once, and explain you want a buffer rather than a hoard. What limits you is usually the pharmacy system, not the drug — and some of it cannot be stockpiled at all, which the Medical kit is honest about.",
            rotateMonths: 6,
          },
          {
            name: "Over-the-counter shelf, in household quantities",
            note: "Painkillers, antihistamine, loperamide, rehydration salts, antacids. Buy plain generics in bulk. Rehydration salts are the ones that save a life here: a stomach bug dehydrates small children and old people faster than anything else in an outage.",
            rotateMonths: 36,
          },
          {
            name: "Thermometer, blood pressure cuff, pulse oximeter",
            note: "Numbers turn 'he seems worse' into a decision about whether to travel for help. Note each person's normal readings on paper while everyone is well.",
            rotateMonths: 60,
          },
          {
            name: "Spare glasses and the written prescription",
            note: "A spare pair of your current correction, and the prescription with it. Being unable to read a label, a map or a dose is a genuine disability.",
          },
          {
            name: "Dental kit — temporary filling cement and clove oil",
            note: "A lost filling is common, agonising and otherwise untreatable. Cement buys weeks and clove oil buys a night's sleep.",
            rotateMonths: 24,
          },
          {
            name: "Dressings, antiseptic and tape in bulk",
            note: "Household quantities rather than a travel tin. Minor wounds turning septic is the historical killer in every period without antibiotics, and it starts with a scratch nobody washed.",
            rotateMonths: 60,
          },
          {
            name: "Medical summary for each person",
            note: "Conditions, doses, allergies, blood group, GP. Written down, because the person who needs it is often the one who cannot speak.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Power & light",
        items: [
          {
            name: "Inverter generator, 2 kW",
            note: "Inverter type, so its output is clean enough for laptops and radios. Run it monthly under load — a carburettor gummed up by stale fuel is the standard failure. Outside only, never in a garage, and never back-fed into house wiring where it can kill a lineman.",
            rotateMonths: 6,
          },
          {
            name: "Petrol for the generator — 60 L, treated",
            qty: 60,
            unit: "L",
            note: "A 2 kW set on half load burns about 0.7 L an hour, so 60 L is 85 hours: six days of running it four hours a day to keep a freezer cold and everything charged. Running one continuously is neither affordable nor quiet, and quiet matters more than people expect.",
            rotateMonths: 12,
          },
          {
            name: "Solar panel, 200 W, with a charge controller",
            note: "The part that still works after the fuel is gone. Sized for phones, radios, lights and a laptop — it will not heat, pump or cook anything.",
          },
          {
            name: "Deep-cycle or LiFePO4 battery, 100 Ah",
            note: "Lead-acid sulphates and dies if left flat on a shelf; LiFePO4 costs more, lasts around ten times as many cycles and tolerates neglect. Either way, check the state of charge quarterly.",
            rotateMonths: 3,
          },
          {
            name: "Lanterns and head torches, one per person",
            note: "One each, so nobody sits in the dark waiting for somebody else to finish. A rechargeable set plus a set that takes standard cells.",
          },
          {
            name: "Low self-discharge rechargeable cells and a 12 V charger",
            note: "The pre-charged type, because ordinary NiMH cells are flat within months of charging and you will not notice until you need them.",
            rotateMonths: 60,
          },
          {
            name: "Lithium primary cells in the sizes you actually use",
            note: "Ten years on a shelf and they do not leak. Standardise every torch and radio in the house on one cell size — a drawer with five different types in it is a drawer of dead batteries.",
            rotateMonths: 120,
          },
          {
            name: "Candles and oil lamps with spare wicks and fuel",
            note: "Cheap light with nothing electronic to fail, and a serious fire risk in a house full of tired people. Glass chimneys, heavy bases, never left burning in an empty room.",
            rotateMonths: 60,
          },
        ],
      },
      {
        title: "Tools & repair",
        items: [
          {
            name: "Hand tools — saw, hammer, chisels, brace and bit, files",
            note: "Anything that needs mains power is a tool you may not have. Old and heavy secondhand beats new and light, and it can be re-handled when it breaks.",
          },
          {
            name: "Axe, splitting maul and wedges",
            note: "Maul for rounds, axe for limbing. A sharp axe swung tired is how people put a blade through a boot, so split early in the day and stop before you want to.",
          },
          {
            name: "Sharpening kit — files, stones, honing guide",
            note: "Every edged tool here is useless within a week of real work without one, and sharpening is a skill you cannot acquire in the week you need it.",
          },
          {
            name: "Fasteners — screws, nails, bolts, washers",
            note: "The consumable half of every repair. Sorted, labelled and dry, because loose in a damp shed they rust into one lump.",
          },
          {
            name: "Tarps, plastic sheeting, timber and a staple gun",
            note: "Boarding a broken window or covering a stripped roof within the hour is what keeps the weather out of the house and the house habitable.",
          },
          {
            name: "Tapes and adhesives",
            note: "Duct, gaffer and self-amalgamating tape, plus glue. Adhesives dry out on the shelf: superglue is a year once opened, so buy single-use tubes rather than one big bottle.",
            rotateMonths: 60,
          },
          {
            name: "Rope, wire, cordage and a hand winch",
            note: "Moving heavy things without an engine. A come-along and a little thought shifts what four people cannot.",
          },
          {
            name: "Sewing and shoe repair kit",
            note: "Clothing and boots become unbuyable long before they become unwearable. Heavy thread, an awl, spare laces and sole adhesive.",
          },
          {
            name: "Bicycle with spare tubes, tyres, chain and pump",
            note: "Thirty kilometres of range on no fuel, carrying a load nobody could walk with. Rubber perishes in storage, so check tyres and tubes yearly even if it has not moved.",
            rotateMonths: 12,
          },
          {
            name: "Paper manuals — repair, medical, growing, preserving",
            note: "Paper works with no power and no battery. The app carries the field manual; the rest of the shelf is whatever your household actually does.",
          },
        ],
      },
      {
        title: "Seeds & growing",
        items: [
          {
            name: "Open-pollinated vegetable seed — a full year's planting",
            note: "Open-pollinated or heirloom, never F1 hybrid: seed saved from an F1 does not come true, so a hybrid packet is one season and then nothing. Most seed keeps two to three years cool and dry, but onion, leek and parsnip barely make one.",
            rotateMonths: 24,
          },
          {
            name: "Calorie crops — potatoes, beans, squash, kale",
            note: "Salad is water. Potatoes give the most food per square metre in the shortest time, squash keeps all winter in a cool room, and kale goes on producing through frost when nothing else will.",
          },
          {
            name: "Sprouting seed — alfalfa, mung, radish",
            note: "Fresh vitamin C in four days on a windowsill, in any season, using only water. The cheapest answer there is to the deficiency problem in a stored diet.",
            rotateMonths: 24,
          },
          {
            name: "Garden hand tools — fork, spade, hoe, watering can",
            note: "A hoe used weekly beats a rotavator used never. Weeds are what actually lose a crop, not pests and not weather.",
          },
          {
            name: "Compost bin and a plan for kitchen waste",
            note: "The fertility has to come from somewhere once the shops shut. Do not put latrine contents in it unless you know the process and the timescale properly.",
          },
          {
            name: "Fertiliser or well-rotted manure",
            note: "A first-year garden on tired soil yields a fraction of what the packet promises. Start improving the soil this year, not the year you are depending on it.",
            rotateMonths: 24,
          },
          {
            name: "Garden notebook — what you planted, when, and what happened",
            note: "Two seasons of honest notes about your own ground are worth more than any book written about somebody else's climate.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Barter & trade",
        items: [
          {
            name: "Cash in small denominations",
            note: "Cards stop with the network long before money stops meaning anything. Small notes and coins, because change will not exist and nobody gives it.",
            rotateMonths: 12,
          },
          {
            name: "Trade stock — coffee, salt, sugar, batteries, soap, matches, spirits",
            note: "Cheap now, unobtainable later, and divisible enough to trade without opening your whole store to a stranger. Spirits also disinfect and light a fire.",
            rotateMonths: 24,
          },
          {
            name: "Precious metal in small units",
            note: "Only after everything else on this list is done — it stores value, it does not feed anyone. A one-ounce coin cannot buy a week's food without wild overpayment, which is the entire case for small units.",
          },
          {
            name: "A skill other people need",
            note: "Repair, sewing, medicine, brewing, welding, teaching. The only trade good that does not run out and cannot be stolen.",
          },
          {
            name: "A decision about what you will not trade, and who knows what you have",
            note: "Make it now, calmly, with the people you live with. Every account of a real shortage turns on this and nobody improvises it well.",
          },
        ],
      },
      {
        title: "Records",
        items: [
          {
            name: "Documents — see the Documents kit",
            note: "Where the originals and copies live is its own template, because the answer is about places rather than paperwork.",
          },
          {
            name: "Photographs of every room and its contents",
            note: "Insurance after a fire or a flood turns on proving you owned it. Ten minutes with a phone, room by room, drawers and cupboards open.",
            rotateMonths: 12,
          },
          {
            name: "Written inventory of the store, with dates and locations",
            note: "The only defence against owning a fourth box of plasters and no cooking oil. It is also what somebody else works from if you are not there.",
            rotateMonths: 6,
          },
          {
            name: "Printed contact list, meeting points and the family plan",
            note: "A copy for every person and every bag. The out-of-area contact is the one that still works when local networks are saturated.",
            rotateMonths: 12,
          },
          {
            name: "Deeds, insurance, licences — and where each one is",
            note: "Listed here, stored as the Documents kit describes, and reviewed once a year against what has actually changed.",
            rotateMonths: 12,
          },
        ],
      },
    ],
  },

  // Ordered by how fast the thing kills, not by how often you will use it. The
  // chronic medication section says plainly where preparation stops working,
  // because a checklist that implies you can stockpile insulin is worse than no
  // checklist at all.
  {
    key: "medical",
    name: "Medical kit",
    blurb:
      "Trauma at one end, a rotten tooth and three days of diarrhoea at the other. Buy the bleeding-control items once and learn them properly; buy the everyday ones in quantity and rotate them.",
    sections: [
      {
        title: "Bleeding control",
        items: [
          {
            name: "Tourniquets — CAT or SOFTT-W × 2",
            qty: 2,
            unit: "tourniquets",
            note: "Two, because one is often not enough on a thigh and you will not want to loosen the first to find out. Buy from a named supplier: the cheap copies snap at the windlass, which you learn with your hand on an artery. Practise one-handed, on yourself, until it is dull.",
            rotateMonths: 60,
          },
          {
            name: "Pressure bandages × 4",
            qty: 4,
            unit: "bandages",
            note: "Dressing, pressure bar and wrap in one, applied one-handed to yourself if it comes to that. The expiry is about the sterility of the pad rather than the strength of the fabric.",
            rotateMonths: 60,
          },
          {
            name: "Haemostatic gauze × 2",
            qty: 2,
            unit: "packets",
            note: "For bleeding where a tourniquet cannot go — neck, armpit, groin. Pack it firmly right down to the bleeding vessel and hold pressure for three minutes by a watch. The old powder versions are obsolete and burn the wound.",
            rotateMonths: 48,
          },
          {
            name: "Plain gauze rolls and trauma pads",
            note: "You will use far more than you expect: packing one wound properly takes a whole roll and both hands.",
            rotateMonths: 60,
          },
          {
            name: "Vented chest seals × 2",
            qty: 2,
            unit: "seals",
            note: "For any wound between the neck and the navel that might have reached the chest. Vented, so trapped air escapes instead of building into a tension pneumothorax. The adhesive is what ages, and it ages faster in a hot car.",
            rotateMonths: 48,
          },
          {
            name: "Trauma shears",
            note: "Cut the clothing off rather than moving somebody to undress them. You cannot treat what you cannot see, and wet denim does not tear.",
          },
          {
            name: "Permanent marker",
            note: "Write the tourniquet time on the casualty's forehead where nobody can miss it. Handover happens hours later and no one remembers the minute.",
          },
        ],
      },
      {
        title: "Airway & breathing",
        items: [
          {
            name: "Nasopharyngeal airway, 28 Fr, with lubricant",
            note: "Holds an unconscious casualty's airway open when position alone is not enough, and is tolerated without triggering a gag reflex. Not for a head injury leaking fluid from the nose or ears.",
            rotateMonths: 60,
          },
          {
            name: "Pocket mask with a one-way valve",
            note: "Makes rescue breaths something you will actually do for a stranger. Compressions alone are correct for an adult cardiac arrest; the mask is for drowning, children and overdose, where breathing is the problem.",
            rotateMonths: 60,
          },
          {
            name: "Bulb syringe or hand suction",
            note: "Vomit and blood block airways far more often than anything dramatic does. Rolling somebody onto their side is free and works.",
          },
          {
            name: "Bag-valve mask — only with training",
            note: "Used untrained it forces air into the stomach and makes everything worse. This is a training item before it is a kit item.",
          },
        ],
      },
      {
        title: "Wound care",
        items: [
          {
            name: "Sterile saline and a 20 ml irrigation syringe",
            note: "Pressure irrigation is what prevents infection, and the dose is volume rather than antiseptic. Clean drinking water does the same job if that is what you have.",
            rotateMonths: 36,
          },
          {
            name: "Antiseptic — povidone iodine or chlorhexidine",
            note: "For intact skin around the wound and for your own hands. Poured into an open wound it kills the tissue that was about to heal it.",
            rotateMonths: 36,
          },
          {
            name: "Wound closure strips and skin adhesive",
            note: "For a clean, straight cut seen early. Never close a dirty wound, a bite or a puncture — sealing infection inside is far worse than the scar you were avoiding.",
            rotateMonths: 24,
          },
          {
            name: "Sterile dressings in several sizes, and non-adherent pads",
            note: "Non-adherent for burns and grazes, or taking the dressing off takes the new skin with it and you start again.",
            rotateMonths: 60,
          },
          {
            name: "Micropore and zinc oxide tape",
            note: "Zinc oxide is also the blister answer: tape the hot spot while it is still only hot.",
            rotateMonths: 36,
          },
          {
            name: "Hydrocolloid blister dressings",
            note: "The most likely injury to actually stop somebody walking out. Treat at the hot spot, not at the blister.",
            rotateMonths: 36,
          },
          {
            name: "Tweezers, splinter forceps and a magnifier",
            note: "Splinters, grit and ticks. Remove a tick with steady straight traction against the skin — no heat, no oil, no twisting.",
          },
          {
            name: "Antibiotic ointment",
            note: "Worth using on a small clean wound in the first few days. It is not treatment for an infection that has already spread, and redness tracking up a limb is a doctor rather than a tube.",
            rotateMonths: 24,
          },
        ],
      },
      {
        title: "Everyday illness",
        items: [
          {
            name: "Oral rehydration salts × 20 sachets",
            qty: 20,
            unit: "sachets",
            note: "The item on this list most likely to save a life. Diarrhoea kills by dehydration rather than by infection, and the salts replace what plain water cannot. Improvised: six level teaspoons of sugar and half a teaspoon of salt in a litre of clean water.",
            rotateMonths: 36,
          },
          {
            name: "Loperamide",
            note: "Stops the symptom so somebody can travel or work. Not with a high fever or blood in the stool — that is dysentery, and slowing the gut down keeps the infection in.",
            rotateMonths: 36,
          },
          {
            name: "Paracetamol and ibuprofen, in household quantities",
            note: "Fever, pain and inflammation. Ibuprofen is hard on kidneys in someone already dehydrated, so reach for paracetamol first when fluids are short.",
            rotateMonths: 36,
          },
          {
            name: "Antihistamine — one drowsy, one not",
            note: "Stings, hives and hay fever, and the drowsy one doubles as a sleep aid. If it involves the face, the throat or breathing, this is not the treatment and adrenaline is.",
            rotateMonths: 36,
          },
          {
            name: "Adrenaline auto-injectors, if anyone is prescribed one",
            note: "Short-dated, expensive and without any substitute. Two per person, because roughly a third of anaphylaxis needs a second dose, and everybody in the house should know where they are kept.",
            rotateMonths: 18,
          },
          {
            name: "Antacids, laxatives and anti-emetics",
            note: "A sudden change of diet and a lot of stress affect both ends. Constipation on a stored diet with almost no fibre in it is genuinely common and genuinely miserable.",
            rotateMonths: 36,
          },
          {
            name: "Cough, cold and sore throat remedies",
            note: "They treat the misery rather than the illness, and the misery is what stops people sleeping and working.",
            rotateMonths: 24,
          },
          {
            name: "Digital thermometer with spare batteries",
            note: "Fever is what separates a bug that will pass from something that needs a doctor while there is still one to reach.",
            rotateMonths: 60,
          },
          {
            name: "Antifungal cream and foot powder",
            note: "Damp boots and no laundry. Foot rot becomes a mobility problem inside a week and takes a month to undo.",
            rotateMonths: 36,
          },
          {
            name: "Eye wash and lubricating drops",
            note: "Dust, smoke and grit, all of which get far more common once you are cooking and heating with fire.",
            rotateMonths: 24,
          },
        ],
      },
      {
        title: "Splints, burns & injuries",
        items: [
          {
            name: "Mouldable splints × 2 and triangular bandages × 4",
            note: "Splint the joint above and below the break, then check that fingers or toes stay warm, pink and feeling. A splint that turns a hand white is worse than none.",
            rotateMonths: 60,
          },
          {
            name: "Elastic and cohesive bandages",
            note: "Sprains, and holding a dressing onto a joint that will not stay wrapped.",
            rotateMonths: 60,
          },
          {
            name: "Burn dressings and cling film",
            note: "Cool a burn under running water for twenty minutes — that is the treatment, and it still helps up to three hours later. Cling film is the best cover you own: sterile inside the roll, transparent, and it does not stick to the burn.",
            rotateMonths: 36,
          },
          {
            name: "Instant cold packs",
            note: "For where there is no cold running water. Cold water is better, and free.",
            rotateMonths: 60,
          },
          {
            name: "Space blankets × 2",
            qty: 2,
            unit: "blankets",
            note: "Shock and blood loss both drop body temperature, and a cold casualty stops clotting properly. Covering somebody is treatment, not comfort.",
            rotateMonths: 60,
          },
          {
            name: "Emergency dental — temporary cement and clove oil",
            note: "Toothache with no dentist is the injury people underestimate most. Cement buys weeks; clove oil buys the night.",
            rotateMonths: 24,
          },
        ],
      },
      {
        title: "Chronic medication — what you cannot stockpile",
        items: [
          {
            name: "A written list of every medicine, dose and reason",
            note: "Names, doses, prescriber, and what happens if it stops. Start here, because the answer is different for every drug on the list and some of them have no answer.",
            rotateMonths: 6,
          },
          {
            name: "The longest supply your prescriber will legitimately write",
            note: "Ask at every repeat rather than once, and say you want a buffer rather than a stockpile. Holiday supplies, longer scripts and ordering early are normal requests; most limits are administrative rather than clinical.",
            rotateMonths: 6,
          },
          {
            name: "Insulin — plan for cold, not for quantity",
            note: "It needs a cold chain and it has a real expiry, so a year of it is not a plan. Work on cooling without power — a cellar, a cool box, an evaporative pot — and know that in-use vials tolerate room temperature for a few weeks.",
          },
          {
            name: "Drugs that must not be stopped abruptly",
            note: "Beta blockers, steroids, anti-epileptics, antidepressants and benzodiazepines all cause real harm on sudden withdrawal, sometimes worse than the condition being treated. If supply is running out, tapering on advice beats running to zero.",
          },
          {
            name: "Oxygen and mains-powered devices",
            note: "A concentrator needs power that will not be there. Cylinders, a generator dedicated to it, or moving early to somewhere with power — and that is a decision to make in advance, not at 2 a.m.",
          },
          {
            name: "Antibiotics — the honest position",
            note: "They are prescription-only for good reasons: the right one depends on the infection, self-prescribing breeds resistance, and taking them masks a condition that actually needs surgery. If your doctor will issue a standby course for a specific known risk, keep it labelled and untouched.",
          },
          {
            name: "Contraception",
            note: "Easy to overlook and impossible to improvise well. Long-acting methods keep working with no supply chain at all, which is the whole point.",
            rotateMonths: 12,
          },
          {
            name: "Glasses, hearing aid batteries, mobility aids",
            note: "The unglamorous dependencies that decide whether somebody can function. A spare pair of glasses is cheap; being unable to see is not.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Infection control",
        items: [
          {
            name: "Nitrile gloves — 100",
            qty: 100,
            unit: "gloves",
            note: "Boxes rather than pairs, because you change them between patients and after every mess. Nitrile rather than latex: no allergy risk and it does not perish in a warm cupboard.",
            rotateMonths: 60,
          },
          {
            name: "Face masks and eye protection",
            note: "Respiratory illness spreads fastest exactly when a household is shut indoors together. The elastic and the nose foam are what age, not the filter.",
            rotateMonths: 60,
          },
          {
            name: "Alcohol hand rub and soap",
            note: "Soap and water first for anything visibly dirty, and for norovirus, which alcohol does not touch at all.",
            rotateMonths: 36,
          },
          {
            name: "Sharps container and a waste plan",
            note: "Needles, dressings and anything bloodied. A rigid bottle with a screw cap works; a bin bag does not and never did.",
          },
          {
            name: "Isolation plan — one room, one carer",
            note: "Decide which room, which door and who nurses, before anybody is ill. Everyone taking turns is how a household of six becomes six patients in a fortnight.",
          },
        ],
      },
      {
        title: "Reference & training",
        items: [
          {
            name: "A first aid course you have actually taken",
            note: "The highest-value line in this template and the only one that cannot be bought in the week you need it. Certificates lapse for a reason: protocols change and skills fade fast.",
            rotateMonths: 36,
          },
          {
            name: "Printed first aid manual",
            note: "Paper, indexed, and read before the emergency rather than during it. The app carries FM 3-05.70; a civilian manual covers the everyday half of this list far better.",
          },
          {
            name: "Where the nearest hospital, pharmacy and doctor are",
            note: "Written down, with the route on foot and by bike, and which of them have generators. Checked yearly, because clinics close and departments move.",
            rotateMonths: 12,
          },
          {
            name: "A medical summary for each person, sealed in the kit",
            note: "Conditions, medicines, allergies, blood group, next of kin. One copy here and one in the go bag, because the kit and the person do not always travel together.",
            rotateMonths: 12,
          },
        ],
      },
    ],
  },

  // Every item here names its locations rather than its contents. That is the
  // whole design: the app never holds a scan of anything, and what people
  // actually get wrong is not owning the document but keeping all three copies
  // in the same building.
  {
    key: "documents",
    name: "Documents & records",
    blurb:
      "What to have, and where each copy lives. Nothing is stored in the app — this is a list of places, so that no single fire, flood or theft takes all three copies of anything.",
    sections: [
      {
        title: "How the copies are held",
        items: [
          {
            name: "Three copies of everything — original, near, distant",
            note: "Original in the fire safe, paper copy in the go bag, encrypted copy well away from the house. One fire can take the first two, which is why the third is the one that matters.",
          },
          {
            name: "Fire safe or document box, bolted down",
            note: "Rated for an hour at minimum, and fixed or too heavy to carry — an unbolted safe is a box a thief takes away to open at leisure. Paper survives a soaking inside a sealed bag; memory cards and drives often do not.",
          },
          {
            name: "Grab folder — the paper copies that leave with you",
            note: "One waterproof wallet, packed already, living in the go bag. Deciding what to photocopy while the water rises means you have already lost.",
            rotateMonths: 12,
          },
          {
            name: "Encrypted off-site copy",
            note: "A drive with someone you trust a long way away, or storage you can still reach from a borrowed device. Encrypted, with the passphrase memorised rather than written on the label.",
            rotateMonths: 12,
          },
          {
            name: "One-page index of what exists and where each copy is",
            note: "Without it nobody else can find any of this, and the entire point of the third copy is that somebody else can.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Identity",
        items: [
          {
            name: "Passport — original in the fire safe, copy in the go bag, encrypted copy off-site",
            note: "Check the expiry every year. Many countries require six months of validity, and renewals stop being possible in exactly the circumstances you are planning for.",
            rotateMonths: 12,
          },
          {
            name: "Driving licence — original in your wallet, copy in the go bag, encrypted copy off-site",
            note: "Photocard expiry is easy to miss because the driving entitlement does not expire alongside it.",
            rotateMonths: 12,
          },
          {
            name: "Birth and marriage certificates — originals in the fire safe, copies in the go bag",
            note: "Certified copies rather than photocopies for anything you may have to prove. Replacing them takes weeks even in normal times.",
          },
          {
            name: "National insurance or social security number — copy in the go bag, encrypted copy off-site",
            note: "The number is what gets asked for, so the card itself stays in the safe. It is also all that identity theft needs, which is why nothing plain travels.",
          },
          {
            name: "Immigration and residency papers — original in the fire safe, copies in the go bag and off-site",
            note: "For anybody in the household whose right to be somewhere has to be proved. Of everything here, this is the loss that is hardest to undo.",
          },
          {
            name: "Current photographs of every person and pet — go bag and off-site",
            note: "For finding people rather than for sentiment. Updated yearly, and more often than that for children.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Property & insurance",
        items: [
          {
            name: "Deeds or lease — original in the fire safe or with the solicitor, copy off-site",
            note: "Registered title can usually be recovered from the land registry. A lease and the correspondence around it often cannot.",
          },
          {
            name: "Home, contents, vehicle and travel policies — copy in the go bag, encrypted copy off-site",
            note: "What you need at three in the morning is the policy number and the claims line, not the schedule. Review the cover yearly against what you now actually own.",
            rotateMonths: 12,
          },
          {
            name: "Contents inventory and photographs — encrypted copy off-site",
            note: "Claims are decided on proof of ownership. Ten minutes with a phone, room by room, with the drawers open, settles arguments that otherwise last a year.",
            rotateMonths: 12,
          },
          {
            name: "Vehicle registration and service history — copy in the vehicle, original in the fire safe",
            note: "The copy stays in the car because that is where it gets asked for, and the original stays home because that is what proves ownership if the car is taken.",
          },
          {
            name: "Utility accounts, meter numbers, stopcock and isolator locations",
            note: "Where the water, gas and electricity are turned off, in writing, so anybody in the house can do it alone. Photograph the meters and the valves as well as writing it down.",
            rotateMonths: 12,
          },
        ],
      },
      {
        title: "Financial",
        items: [
          {
            name: "Bank and account details — encrypted copy off-site, nothing plain in any bag",
            note: "Account and branch details, never cards or PINs. Enough to prove who you are to a bank whose local branch no longer exists.",
          },
          {
            name: "Cash — two weeks of ordinary spending, in small notes",
            note: "Cards stop with the network. Split it between the safe, the go bag and the vehicle, because losing one location should not lose all of it. Count and refresh it yearly.",
            rotateMonths: 12,
          },
          {
            name: "One page of debts, mortgages and standing orders — off-site",
            note: "What leaves the account, to whom, and when. This is what stops a temporary crisis turning into a permanent one through missed payments nobody knew about.",
            rotateMonths: 12,
          },
          {
            name: "Tax records and payslips — encrypted copy off-site",
            note: "Proof of income is what aid, credit and most claims turn on. Keep two years reachable and archive the rest.",
            rotateMonths: 12,
          },
          {
            name: "Pension, investment and safe deposit details — encrypted copy off-site",
            note: "Written down because institutions merge and change names, and an account nobody knows about is an account that is lost for good.",
          },
        ],
      },
      {
        title: "Medical",
        items: [
          {
            name: "Medical summary per person — copy in the go bag, copy in the vehicle",
            note: "Conditions, medicines and doses, allergies, blood group, GP and next of kin, on one side of paper. See the Medical kit for what belongs on it.",
            rotateMonths: 12,
          },
          {
            name: "Prescriptions and repeat slips — copy in the go bag",
            note: "A pharmacist somewhere else can often help on the strength of a written prescription and nothing else.",
            rotateMonths: 6,
          },
          {
            name: "Vaccination records — copy in the go bag, encrypted copy off-site",
            note: "Asked for by schools, borders and shelters. Tetanus dates especially, because you will be handling dirty metal and old wood.",
          },
          {
            name: "Advance directive, organ donation and health power of attorney",
            note: "The documents that speak for you when you cannot. Their only value is being found in time, so the copy held by your next of kin matters more than the one in the safe.",
          },
        ],
      },
      {
        title: "Legal & family",
        items: [
          {
            name: "Wills — original with the executor or solicitor, copy in the fire safe",
            note: "An original kept at home that burns with you becomes a legal problem for exactly the people it was meant to protect.",
          },
          {
            name: "Power of attorney, guardianship and custody orders",
            note: "Who may act for whom. Schools and hospitals ask for these at precisely the moment nobody can find them.",
          },
          {
            name: "Family contact list and meeting plan — printed, in every bag and wallet",
            note: "Including the out-of-area contact everybody calls when local networks are saturated. Children carry it too, on paper, in a pocket.",
            rotateMonths: 12,
          },
          {
            name: "Pet records — microchip number, vaccinations, ownership",
            note: "Boarding and shelters refuse animals without them, and the microchip number is how a lost animal finds its way back.",
          },
          {
            name: "Qualifications and professional licences — encrypted copy off-site",
            note: "Proof that you can do the work is what gets you hired, or trusted, somewhere you are not known.",
          },
        ],
      },
      {
        title: "Digital & keys",
        items: [
          {
            name: "Password manager, with an emergency access plan",
            note: "The master passphrase written once and sealed with the will or with someone trusted. Everything else in your life is behind it, and nobody can reach any of it if you cannot.",
            rotateMonths: 12,
          },
          {
            name: "Two-factor backup codes — printed, in the safe",
            note: "A lost phone locks you out of your own accounts far more thoroughly than a forgotten password ever did. Printed, because the codes live on the device you no longer have.",
            rotateMonths: 12,
          },
          {
            name: "Spare keys — house, vehicle, safe, outbuildings",
            note: "One set with a neighbour and one set further away. Label them so they mean something to you and nothing to a stranger who finds them.",
          },
          {
            name: "Serial numbers and photographs of valuables",
            note: "Police and insurers both ask for them. A photograph of the serial plate takes seconds and is worth more than a written list.",
            rotateMonths: 12,
          },
          {
            name: "Backup of family photographs and records",
            note: "The only things on this entire list that cannot be reissued by anybody. One copy in the safe, one off-site, and check once a year that it still opens.",
            rotateMonths: 6,
          },
        ],
      },
    ],
  },

  // Radios fail in three ways and only three: flat, unprogrammed, or nobody
  // listening at the other end. So this template weights the routine — the
  // frequency card, the schedule, the weekly check — as heavily as the hardware.
  {
    key: "comms",
    name: "Comms kit",
    blurb:
      "Radios that reach the people you actually need to reach. Everything here fails the same few ways — flat, unprogrammed, or with nobody listening — so half the list is the routine rather than the hardware.",
    sections: [
      {
        title: "Handheld radios",
        items: [
          {
            name: "Handhelds — one per person, all the same model",
            note: "The same model throughout, so there is one manual, one battery, one charger and one set of instructions to teach. A mixed set means somebody always has the radio nobody else can fix.",
          },
          {
            name: "Licence-free radios for the household (PMR446, FRS, GMRS)",
            note: "No licence and no exam, and one to two kilometres in real terrain whatever the box claims. Fine for the garden, the street and a convoy; useless over a hill.",
          },
          {
            name: "Amateur radio licence, and radios to match",
            note: "The exam is a weekend and it is the difference between owning a radio and being able to use one. The licence is not the point — the skill and the local network of people who also have one is.",
            rotateMonths: 60,
          },
          {
            name: "Programming cable and the software on a laptop",
            note: "Channels typed in at a keypad get typed in wrong. Set them once from a computer, save the file, and keep a copy alongside the frequency card.",
          },
          {
            name: "Spare battery packs, one per radio",
            note: "Lithium packs age on the shelf whether used or not — capacity falls for about three years and then they fail without warning. Store them half charged rather than full.",
            rotateMonths: 36,
          },
          {
            name: "Battery case that takes AA cells",
            note: "Weak, short-range and the thing that still works when the pack has died and there is no charger. Worth the few pounds for that alone.",
          },
          {
            name: "Speaker microphone",
            note: "Keeps the radio on your chest where you can hear it instead of in a pocket where you cannot. It is also the first thing to fail, because it is a cable that gets pulled.",
          },
        ],
      },
      {
        title: "Base & vehicle",
        items: [
          {
            name: "Mobile transceiver in the vehicle, fused at the battery",
            note: "Ten times the power of a handheld and, far more importantly, a real antenna on a metal roof. Fused at the battery, not spliced into an accessory circuit that dies with the ignition.",
          },
          {
            name: "Base station, or the mobile on a bench supply at home",
            note: "The station that stays switched on when nobody is carrying a radio. Somebody listening is what makes a net exist at all.",
          },
          {
            name: "SWR meter",
            note: "Tells you whether the antenna is radiating or reflecting power back into the radio. Ten minutes with one separates a working station from a warm one.",
          },
          {
            name: "Dummy load",
            note: "For testing and adjusting without putting anything on the air, which matters more the fewer people there are to interfere with.",
          },
          {
            name: "Earthing and a coax surge arrestor for anything on a mast",
            note: "A direct strike is unsurvivable for the equipment however you wire it. An induced surge from a strike a field away is the common case, and that is what this stops.",
          },
        ],
      },
      {
        title: "Antennas",
        items: [
          {
            name: "Replace the stock rubber duck aerial",
            note: "The cheapest single improvement to any handheld — the supplied aerial is a compromise for pocket size. A proper whip roughly doubles usable range for a few pounds.",
          },
          {
            name: "Roll-up J-pole or slim jim in the go bag",
            note: "Hung in a tree at six metres, a 5 W handheld reaches further than a 50 W set at waist height. Height beats power every single time.",
          },
          {
            name: "Coax, connectors and adapters",
            note: "Buy decent coax: thin cable loses more than the extra transmit power anyone argues about. Sunlight destroys the outer jacket within a few years outdoors.",
            rotateMonths: 60,
          },
          {
            name: "Wire, insulators and a throw line",
            note: "A length of wire in a tree is a working HF antenna. The throw line is what gets it up there without anybody climbing in the dark.",
          },
          {
            name: "Magnetic mount for the vehicle",
            note: "The roof is the ground plane and it matters — a bonnet or boot lid halves the pattern in the direction you care about. Take it off before car washes and low branches.",
          },
        ],
      },
      {
        title: "Power & charging",
        items: [
          {
            name: "Chargers — mains, 12 V and USB, for every radio",
            note: "The 12 V lead is the one that keeps working. Mains chargers are the first thing on this list to become ornaments.",
          },
          {
            name: "Solar panel, 20–50 W, with USB and 12 V outputs",
            note: "Enough to keep radios, phones and a mesh node running indefinitely. Not enough to keep a base station transmitting.",
          },
          {
            name: "Power bank, 20,000 mAh",
            note: "Top it up quarterly. A power bank left flat for a year is not a low battery, it is a dead one, and lithium cells do not come back.",
            rotateMonths: 3,
          },
          {
            name: "AA and AAA lithium primaries",
            note: "Ten years on a shelf, immune to cold, and they never leak inside the equipment. This is the battery to standardise on for anything that sits unused for years.",
            rotateMonths: 120,
          },
          {
            name: "Low self-discharge rechargeables and a 12 V charger",
            note: "For the radios you use weekly. Ordinary NiMH cells are flat within months of charging; the pre-charged type still holds most of it a year later.",
            rotateMonths: 60,
          },
          {
            name: "One 12 V connector standard — Anderson plugs and fused leads",
            note: "So any battery you own powers any radio you own without improvising with crocodile clips at night.",
          },
        ],
      },
      {
        title: "Mesh — Meshtastic",
        items: [
          {
            name: "Meshtastic node — LoRa, on a licence-free band",
            note: "Text and positions across a mesh that forms itself with no infrastructure, a few kilometres per hop and much further from high ground. Pair it over Bluetooth or USB and the app's Team panel plots what arrives.",
          },
          {
            name: "A second node, so there is a mesh at all",
            note: "One node is a paperweight. Two is a link. Three or four with one of them high is coverage of a whole valley.",
          },
          {
            name: "Solar repeater node on high ground",
            note: "A node in a weatherproof box, left on a hill, is what turns line-of-sight into coverage. It needs no attention beyond the battery and it multiplies everything else you own.",
          },
          {
            name: "Shared channel and key, set before you need it",
            note: "Everybody must have the same channel and key or nobody hears anybody. Set it in person, note where it is stored, and change it if a node is lost or stolen.",
            rotateMonths: 12,
          },
          {
            name: "GPS-equipped node for anyone moving",
            note: "Position beacons are what the Team panel is for. Every fix is minutes old at best, which is exactly why the app shows the age of each one rather than just the dot.",
          },
          {
            name: "Spare boards, antennas and 18650 cells",
            note: "Cheap now and unbuyable later. The antenna connector is the fragile part, and powering a LoRa board up with no antenna attached damages the transmitter.",
            rotateMonths: 36,
          },
        ],
      },
      {
        title: "Listening",
        items: [
          {
            name: "Shortwave receiver with SSB",
            note: "News from outside your area when local broadcasting stops, and it needs no licence and no permission from anyone. SSB is the part that matters — without it you hear broadcasters but not amateurs.",
            rotateMonths: 60,
          },
          {
            name: "Wind-up or solar radio with AM, FM and long wave",
            note: "Tinny, slow to charge, and the last receiver still working when every battery in the house is flat.",
          },
          {
            name: "Scanner or SDR dongle with a laptop",
            note: "Hears what is happening around you. Receiving is legal nearly everywhere; repeating what you heard often is not.",
          },
          {
            name: "Weather alert receiver",
            note: "Wakes you for a warning you would otherwise sleep through. In a storm that is worth more than any transmitter on this list.",
          },
        ],
      },
      {
        title: "Paperwork & routine",
        items: [
          {
            name: "Frequency card — laminated, one per radio",
            note: "Channels, repeater offsets and tones, your group's simplex frequencies, local nets and emergency channels. On paper, because a radio that resets itself is a brick without it.",
            rotateMonths: 12,
          },
          {
            name: "Comms plan — who calls whom, when, and on what",
            note: "A schedule beats monitoring: everybody listens for five minutes at the top of the hour and the batteries last ten times as long. Decide primary, alternate, contingency and emergency now, while it is a conversation rather than a problem.",
            rotateMonths: 12,
          },
          {
            name: "Logbook and pencil",
            note: "Times, call signs and what was said. Memory under stress is unreliable, and a log settles the argument about who was told what.",
          },
          {
            name: "Call signs and a short codeword list",
            note: "Names on air identify your household to everyone listening. Assume every transmission is heard by strangers: plain language, no addresses, nothing about what you have.",
            rotateMonths: 12,
          },
          {
            name: "A radio check with your group, monthly at worst",
            note: "A net that has never been run does not exist. Weekly if people will do it — the point is to find the flat battery and the wrong tone now rather than on the day.",
            rotateMonths: 1,
          },
        ],
      },
      {
        title: "Signalling without radio",
        items: [
          {
            name: "Whistle on every person",
            note: "Three blasts is distress. It carries far past a shout, needs no power, and works when you have lost your voice or cannot risk using it.",
          },
          {
            name: "Signal mirror",
            note: "Visible for miles in sunlight with no power at all. Aim through the sighting hole at the aircraft; practise once in the garden, because it is not obvious the first time.",
          },
          {
            name: "High-power torch and chemical lights",
            note: "Three flashes is the same distress signal after dark. Chemical lights mark a position or a casualty with no battery and no switch to fail.",
            rotateMonths: 48,
          },
          {
            name: "Marker panel or a bright tarp",
            note: "A large V on the ground means assistance required and an X means medical help — the handbook has the rest. It works when everything electronic has gone.",
          },
          {
            name: "Prearranged physical signals at home",
            note: "A particular curtain, a chalk mark, a ribbon on the gate: 'we are here and well', or 'we have gone to the rally point'. Agreed in advance and meaningless to anybody else.",
          },
        ],
      },
    ],
  },
];
