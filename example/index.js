import {
	WebGLRenderer,
	PerspectiveCamera,
	Color,
	Scene,
	DirectionalLight,
	AmbientLight,
	sRGBEncoding,
	Group,
	Raycaster,
	Vector2,
	Vector4,
	Mesh,
	SphereBufferGeometry,
	MeshBasicMaterial,
} from 'three';
import {
    OrbitControls,
} from 'three/examples/jsm/controls/OrbitControls.js';
import {
	TransformControls
} from 'three/examples/jsm/controls/TransformControls.js';
import {
	GUI,
} from 'three/examples/jsm/libs/dat.gui.module.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { mat4 } from 'gl-matrix';
import {
	Solver,
	WorkerSolver,
	Link,
	Joint,
	SOLVE_STATUS_NAMES,

	IKRootsHelper,
	setUrdfFromIK,
} from '../src/index.js';
import {
	loadATHLETE,
	loadRobonaut,
} from './loadModels.js';

const params = {
	solve: true,
	displayMesh: true,
	displayIk: true,
	displayGoals: true,
	model: 'ATHLETE',
	webworker: true,
};

const solverOptions = {
	maxIterations: 3,
	divergeThreshold: 0.05,
	stallThreshold: 1e-4,
	translationErrorClamp: 0.25,
	rotationErrorClamp: 0.25,
	restPoseFactor: 0.01,
};

const goalToLinkMap = new Map();
const linkToGoalMap = new Map();
const extraGoals = [];
const goalIcons = [];
let selectedGoalIndex = - 1;

let loadId = 0;
let gui;
const stats = new Stats();
document.body.appendChild( stats.dom );

const outputContainer = document.getElementById( 'output' );

// init renderer
const renderer = new WebGLRenderer( { antialias: true } );
renderer.setPixelRatio( window.devicePixelRatio );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.outputEncoding = sRGBEncoding;
document.body.appendChild( renderer.domElement );

const camera = new PerspectiveCamera( 50, window.innerWidth / window.innerHeight );
camera.position.set( 8, 8, 8 );

const scene = new Scene();
scene.background = new Color( 0x131619 );

const directionalLight = new DirectionalLight();
directionalLight.position.set( 1, 3, 2 );
scene.add( directionalLight );

const ambientLight = new AmbientLight( 0x263238, 1 );
scene.add( ambientLight );

const controls = new OrbitControls( camera, renderer.domElement );
const transformControls = new TransformControls( camera, renderer.domElement );
transformControls.setSpace( 'local' );
scene.add( transformControls );

transformControls.addEventListener( 'mouseDown', () => controls.enabled = false );
transformControls.addEventListener( 'mouseUp', () => controls.enabled = true );

const targetObject = new Group();
targetObject.position.set( 0, 1, 1 )
scene.add( targetObject );
transformControls.attach( targetObject );

let solver, ikHelper, drawThroughIkHelper, ikRoot, urdfRoot;
loadModel( loadATHLETE() );
rebuildGUI();
render();

window.addEventListener( 'resize', () => {

    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;

    renderer.setSize( w, h );

    camera.aspect = aspect;
	camera.updateProjectionMatrix();

	ikHelper.setResolution( window.innerWidth, window.innerHeight );
	drawThroughIkHelper.setResolution( window.innerWidth, window.innerHeight );

} );

window.addEventListener( 'keydown', e => {

	switch( e.key ) {
		case 'w':
			transformControls.setMode( 'translate' );
			break;
		case 'e':
			transformControls.setMode( 'rotate' );
			break;
		case 'q':
			transformControls.setSpace( transformControls.space === 'local' ? 'world' : 'local' );
			break;
		case 'f':
			controls.target.set( 0, 0, 0 );
			controls.update();
			break;
	}

} );

let startX = 0;
let startY = 0;
transformControls.addEventListener( 'mouseUp', () => {

	if ( selectedGoalIndex !== - 1 ) {

		const goal = extraGoals[ selectedGoalIndex ];
		const ikLink = goalToLinkMap.get( goal );
		if ( ikLink ) {

			ikLink.updateMatrixWorld();

			ikLink.attachChild( goal );
			goal.setPosition( ...goal.originalPosition );
			goal.setQuaternion( ...goal.originalQuaternion );
			ikLink.detachChild( goal );

			targetObject.position.set( ...goal.position );
			targetObject.quaternion.set( ...goal.quaternion );

		}

	}

} );

renderer.domElement.addEventListener( 'pointerdown', e => {

	startX = e.clientX;
	startY = e.clientY;

} );

renderer.domElement.addEventListener( 'pointerup', e => {

	if ( Math.abs( e.clientX - startX ) > 3 ||  Math.abs( e.clientY - startY ) > 3 ) return;

	if ( ! urdfRoot ) return;

	const { ikLink, result } = raycast( e );

	if ( ikLink === null ) {

		selectedGoalIndex = - 1;

	}

	if ( e.button === 2 ) {

		if ( ! ikLink ) {

			return;

		}

		if ( linkToGoalMap.has( ikLink ) ) {

			const goal = linkToGoalMap.get( ikLink );
			linkToGoalMap.delete( ikLink );
			goalToLinkMap.delete( goal );

			const i = extraGoals.indexOf( goal );
			extraGoals.splice( i, 1 );

			const i2 = solver.roots.indexOf( goal );
			solver.roots.splice( i2, 1 );
			solver.updateStructure();

		}

		// normal in world space
		const norm4 = new Vector4();
		norm4.copy( result.face.normal );
		norm4.w = 0;
		norm4.applyMatrix4( result.object.matrixWorld );

		// create look matrix
		const lookMat = mat4.create();
		const eyeVec = [ 0, 0, 0 ];
		const posVec = norm4.toArray();
		let upVec = [ 0, 1, 0 ];
		if ( Math.abs( posVec[ 1 ] ) > 0.9 ) {

			upVec = [ 0, 0, 1 ];

		}
		mat4.targetTo( lookMat, eyeVec, posVec, upVec );

		const rootGoalJoint = new Joint();
		rootGoalJoint.setPosition(
			result.point.x,
			result.point.y,
			result.point.z,
		);
		mat4.getRotation( rootGoalJoint.quaternion, lookMat );

		const goalLink = new Link;

		const goalJoint = new Joint();
		ikLink.getWorldPosition( goalJoint.position );
		ikLink.getWorldQuaternion( goalJoint.quaternion );
		goalJoint.setMatrixNeedsUpdate();

		rootGoalJoint.attachChild( goalLink );
		goalLink.attachChild( goalJoint );
		goalJoint.addChild( ikLink );

		// save the relative position
		ikLink.attachChild( rootGoalJoint );
		rootGoalJoint.originalPosition = rootGoalJoint.position.slice();
		rootGoalJoint.originalQuaternion = rootGoalJoint.quaternion.slice();
		ikLink.detachChild( rootGoalJoint );

		// update the solver
		solver.roots.push( rootGoalJoint );
		solver.updateStructure();

		targetObject.position.set( ...rootGoalJoint.position );
		targetObject.quaternion.set( ...rootGoalJoint.quaternion );

		goalToLinkMap.set( rootGoalJoint, ikLink );
		linkToGoalMap.set( ikLink, rootGoalJoint );
		extraGoals.push( rootGoalJoint );
		selectedGoalIndex = extraGoals.length - 1;

	} else if ( e.button === 0 ) {

		if ( ! transformControls.dragging ) {

			selectedGoalIndex = goalIcons.indexOf( result ? result.object.parent : null );

			if ( selectedGoalIndex !== -1 ) {

				const ikgoal = extraGoals[ selectedGoalIndex ];
				targetObject.position.set( ...ikgoal.position );
				targetObject.quaternion.set( ...ikgoal.quaternion );

			} else if ( ikLink && linkToGoalMap.has( ikLink ) ) {

				const goal = linkToGoalMap.get( ikLink );
				selectedGoalIndex = extraGoals.indexOf( goal );
				targetObject.position.set( ...goal.position );
				targetObject.quaternion.set( ...goal.quaternion );

			}

		}

	}

} );

window.addEventListener( 'keydown', e => {

	if ( selectedGoalIndex !== - 1 && e.code === 'Delete' ) {

		const goalToRemove = extraGoals[ selectedGoalIndex ];
		const i = solver.roots.indexOf( goalToRemove );
		solver.roots.splice( i, 1 );
		solver.updateStructure();

		extraGoals.splice( selectedGoalIndex, 1 );
		selectedGoalIndex = - 1;

		const link = goalToLinkMap.get( goalToRemove );
		goalToLinkMap.delete( goalToRemove );
		linkToGoalMap.delete( link );

	}

} );

function raycast( e ) {

	const raycaster = new Raycaster();
	const mouse = new Vector2();
	mouse.x = ( e.clientX / window.innerWidth ) * 2 - 1;
	mouse.y = - ( e.clientY / window.innerHeight ) * 2 + 1;

	raycaster.setFromCamera( mouse, camera );

	let results;
	const fewerGoals = [ ...goalIcons ];
	fewerGoals.length = extraGoals.length;
	results = raycaster.intersectObjects( fewerGoals, true );
	if ( results.length !== 0 ) {

		return { ikLink: null, result: results[ 0 ] };

	}

	results = raycaster.intersectObjects( [ urdfRoot ], true );
	if ( results.length === 0 ) {

		return { ikLink: null, result: null };

	}
	const result = results[ 0 ];

	let nearestLink = null;
	let ikLink = null;
	result.object.traverseAncestors( p => {

		if ( nearestLink === null && p.isURDFLink ) {

			nearestLink = p;
			ikRoot.traverse( c => {

				if ( c.name === nearestLink.name ) {

					ikLink = c;

				}

			} );

		}

	} );

	return { ikLink, result };

}

let averageTime = 0;
let averageCount = 0;
function render() {

	requestAnimationFrame( render );

	const allGoals = extraGoals;
	const selectedGoal = allGoals[ selectedGoalIndex ];
	if ( ikRoot ) {

		if ( selectedGoal ) {

			selectedGoal.setPosition( targetObject.position.x, targetObject.position.y, targetObject.position.z );
			selectedGoal.setQuaternion( targetObject.quaternion.x, targetObject.quaternion.y, targetObject.quaternion.z, targetObject.quaternion.w );

		}

		if ( params.solve ) {

			const startTime = window.performance.now();
			let statuses;
			if ( solver instanceof WorkerSolver ) {

				solver.updateFrameState( ...allGoals );
				solver.updateSolverSettings( solverOptions );

				statuses = [ solver.status ];
				if ( ! solver.running ) {

					solver.solve();

				}

			} else {

				Object.assign( solverOptions );
				statuses = solver.solve();

			}
			const endTime = window.performance.now();
			const deltaTime = endTime - startTime;

			outputContainer.innerText = `solve time \t: ${ deltaTime.toFixed( 3 ) }ms\n`;

			if ( averageCount < 50 ) {

				averageCount ++;

			}

			averageTime += ( deltaTime - averageTime ) / averageCount;
			outputContainer.innerText += `avg solve time \t: ${ averageTime.toFixed( 3 ) }ms\n`;
			outputContainer.innerText += statuses.map( s => SOLVE_STATUS_NAMES[ s ] ).join( '\n' );

			setUrdfFromIK( urdfRoot, ikRoot );

		}

		urdfRoot.visible = params.displayMesh;
		ikHelper.visible = params.displayIk;
		drawThroughIkHelper.visible = params.displayIk;

	}

	while ( goalIcons.length < allGoals.length ) {

		const color = new Color( 0xffca28 ).convertSRGBToLinear();
		const group = new Group();
		const mesh = new Mesh(
			new SphereBufferGeometry( 0.05, 30, 30 ),
			new MeshBasicMaterial( { color } ),
		);
		const mesh2 = new Mesh(
			new SphereBufferGeometry( 0.05, 30, 30 ),
			new MeshBasicMaterial( {
				color,
				opacity: 0.4,
				transparent: true,
				depthWrite: false,
				depthTest: false,
			} ),
		);

		// consistent size in screen space.
		const ogUpdateMatrix = mesh.updateMatrix;
		function updateMatrix( ...args ) {

			this.scale.setScalar( this.position.distanceTo( camera.position ) * 0.15 );
			ogUpdateMatrix.call( this, ...args );

		}

		mesh.updateMatrix = updateMatrix;
		mesh2.updateMatrix = updateMatrix;

		group.add( mesh, mesh2 );
		scene.add( group );
		goalIcons.push( group );

	}

	goalIcons.forEach( g => g.visible = false );
	allGoals.forEach( ( g, i ) => {

		goalIcons[ i ].position.set( ...g.position );
		goalIcons[ i ].quaternion.set( ...g.quaternion );
		goalIcons[ i ].visible = params.displayGoals;

	} );

	transformControls.enabled = selectedGoalIndex !== - 1;
	transformControls.visible = selectedGoalIndex !== - 1;

	renderer.render( scene, camera );
	stats.update();

}

function rebuildGUI() {

    if ( gui ) {

        gui.destroy();

	}

	if ( ! ikRoot ) return;

	gui = new GUI();
	gui.width = 350;

	gui.add( params, 'model', [ 'ATHLETE', 'Robonaut' ] ).onChange( value => {

		let promise = null;
		switch( value ) {

			case 'ATHLETE':
				promise = loadATHLETE();
				break;

			case 'Robonaut':
				promise = loadRobonaut();
				break;

		}

		loadModel( promise );

	} );
	gui.add( params, 'displayMesh' ).name( 'display mesh' );
	gui.add( params, 'displayGoals' ).name( 'display goals' );
	gui.add( params, 'displayIk' ).name( 'display ik chains');
	gui.add( params, 'webworker' ).onChange( v => {

		if ( v ) {

			solver = new WorkerSolver( solver.roots );

		} else {

			solver.dispose();
			solver = new Solver( solver.roots );

		}

	} );
	gui.add( { reset: () => {

		let promise = null;
		switch( params.model ) {

			case 'ATHLETE':
				promise = loadATHLETE();
				break;

			case 'Robonaut':
				promise = loadRobonaut();
				break;

		}

		loadModel( promise );

	} }, 'reset' );

	const solveFolder = gui.addFolder( 'solver' );
	solveFolder.add( params, 'solve' ).onChange( v => {

		if ( ! v && solver instanceof WorkerSolver ) {

			solver.stop();

		}

	} );
	solveFolder.add( solverOptions, 'maxIterations' ).min( 1 ).max( 10 ).step( 1 ).listen();
	solveFolder.add( solverOptions, 'divergeThreshold' ).min( 0 ).max( 0.5 ).step( 1e-2 ).listen();
	solveFolder.add( solverOptions, 'stallThreshold' ).min( 0 ).max( 0.01 ).step( 1e-4 ).listen();
	solveFolder.add( solverOptions, 'translationErrorClamp' ).min( 1e-2 ).max( 1 ).listen();
	solveFolder.add( solverOptions, 'rotationErrorClamp' ).min( 1e-2 ).max( 1 ).listen();
	solveFolder.add( solverOptions, 'restPoseFactor' ).min( 0 ).max( 1e-1 ).step( 1e-4 ).listen();
	solveFolder.open();

	// ikRoot.traverse( c => {

    //     if ( c instanceof Joint ) {

    //         const folder = gui.addFolder( c.name );
    //         folder.open();

    //         const names = Object.keys( DOF );
    //         c.dof.forEach( ( dof, i ) => {

    //             folder
    //                 .add( c.dofValues, dof )
    //                 .name( names[ dof ] )
    //                 .min( - Math.PI )
    //                 .max( Math.PI )
    //                 .step( 0.001 )
    //                 .onChange( v => {

	// 					c.setMatrixDoFNeedsUpdate();

	// 				} )
	// 				.listen();

    //         } );

    //     }

    // } );

}

function dispose( c ) {

	if ( c.geometry ) {

		c.geometry.dispose();

	}

	if ( c.material ) {

		function disposeMaterial( material ) {

			material.dispose();
			for ( const key in material ) {

				if ( material[ key ] && material[ key ].isTexture ) {

					material[ key ].dispose();

				}

			}

		}

		if ( Array.isArray( c.material ) ) {

			c.material.forEach( disposeMaterial );

		} else {

			disposeMaterial( c.material );

		}


	}

}

function loadModel( promise ) {

	if ( urdfRoot ) {

		urdfRoot.traverse( dispose );
		drawThroughIkHelper.traverse( dispose );
		ikHelper.traverse( dispose );

		scene.remove( urdfRoot, drawThroughIkHelper, ikHelper );

	}

	ikRoot = null;
	urdfRoot = null;
	ikHelper = null;
	drawThroughIkHelper = null;
	extraGoals.length = 0;
	goalToLinkMap.clear();
	linkToGoalMap.clear();
	selectedGoalIndex = - 1;

	loadId ++;
	const thisLoadId = loadId;
	promise
		.then( ( { goalMap, urdf, ik, helperScale = 1 } ) => {

			if ( loadId !== thisLoadId ) {

				return;

			}

			ik.updateMatrixWorld( true );

			// create the helper
			ikHelper = new IKRootsHelper( [ ik ] );
			ikHelper.update();
			ikHelper.setJointScale( helperScale );
			ikHelper.setResolution( window.innerWidth, window.innerHeight );
			ikHelper.traverse( c => {

				if ( c.material ) {

					c.material.color.set( 0xe91e63 ).convertSRGBToLinear();

				}

			} );

			drawThroughIkHelper = new IKRootsHelper( [ ik ] );
			drawThroughIkHelper.update();
			drawThroughIkHelper.setJointScale( helperScale );
			drawThroughIkHelper.setResolution( window.innerWidth, window.innerHeight );
			drawThroughIkHelper.traverse( c => {

				if ( c.material ) {

					c.material.color.set( 0xe91e63 ).convertSRGBToLinear();
					c.material.opacity = 0.1;
					c.material.transparent = true;
					c.material.depthWrite = false;
					c.material.depthTest = false;

				}

			} );

			scene.add( urdf, ikHelper, drawThroughIkHelper );

			const goals = [];
			goalMap.forEach( ( link, goal ) => {

				goals.push( goal );
				goalToLinkMap.set( goal, link );
				linkToGoalMap.set( link, goal );

			} );

			solver = params.webworker ? new WorkerSolver( [ ik, ...goals ] ) : new Solver( [ ik, ...goals ] );
			solver.maxIterations = 3;
			solver.translationErrorClamp = 0.25;
			solver.rotationErrorClamp = 0.25;
			solver.restPoseFactor = 0.01;
			solver.divergeThreshold = 0.05;

			if ( goals.length ) {

				targetObject.position.set( ...goals[ 0 ].position );
				targetObject.quaternion.set( ...goals[ 0 ].quaternion );
				selectedGoalIndex = 0;

			} else {

				selectedGoalIndex = - 1;

			}

			goals.forEach( g => {

				g.originalPosition = [ 0, 0, 0 ];
				g.originalQuaternion = [ 0, 0, 0, 1 ];

			} );

			ikRoot = ik;
			urdfRoot = urdf;
			extraGoals.push( ...goals );

			rebuildGUI();

		} );

}