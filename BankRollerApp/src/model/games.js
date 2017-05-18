import $          from 'jquery'
import _config    from 'app.config'
import localDB    from 'localforage'
import Eth        from 'Eth/Eth'
import Api        from 'Api'
import bigInt     from 'big-integer'

import * as Utils from 'utils'

import {AsyncPriorityQueue, AsyncTask} from 'async-priority-queue'

let _games = {}
let _seeds_list = {}
let _pendings_list = {}


class Games {
	constructor(){
		this.load()

		this.Queue = new AsyncPriorityQueue({
			debug:               false,
			maxParallel:         1,
			processingFrequency: 350,
		})

		this.Queue.start()
	}


	/*
	 * Random
	 **/
	getConfirmNumber(seed, address, abi, callback){
		Eth.Wallet.getPwDerivedKey( PwDerivedKey => {

			let VRS = Eth.Wallet.lib.signing.signMsg(
				Eth.Wallet.getKs(),
				PwDerivedKey,
				seed,
				_wallet.openkey.substr(2)
			)

			let signature = Eth.Wallet.lib.signing.concatSig(VRS)


			let v = VRS.v
			let r = signature.slice(0, 66)
			let s = '0x' + signature.slice(66, 130)

			/* Equivalent of solidity hash function:
				function confirm(bytes32 _s) public returns(uint256){
					return uint256 (sha3(_s));
				}
			*/
			let hash    = '0x'+Eth.ABI.soliditySHA3(['bytes32'],[ s ]).toString('hex')
			let confirm = bigInt(hash,16).divmod(65536).remainder.value

			callback(confirm, PwDerivedKey, v,r,s)
		})
	}


	load(callback){
		localDB.getItem('Games', (err, games)=>{
			if (games) { _games = games }
			if (callback) callback(games)
		})
	}

	get(callback){
		if (_games && Object.keys(_games).length ) {
			callback(_games)
			return
		}
		this.load(callback)
	}


	create(name, callback){
		// add task to deploy contract
		localDB.getItem('deploy_tasks',(err, tasks)=>{
			if (!tasks) { tasks = [] }

			let task_id = name+'_'+tasks.length
			tasks.push({name:name, task_id:task_id })

			_games[name+'_'+tasks.length] = {
				name: name,
				task_id:task_id,
				deploying: true,
				start_balance:0,
				balance:0,
			}
			localDB.setItem('Games', _games)
			localDB.setItem('deploy_tasks', tasks)

			if (callback) { callback() }
		})

	}

	checkTasks(){
		console.log('checkTasks')
		localDB.getItem('deploy_tasks',(err, tasks)=>{
			if (!tasks || tasks.length==0) {
				setTimeout(()=>{ this.checkTasks() }, 5000)
				console.log('no tasks')
				return
			}

			console.log('Tasks in queue: '+tasks.length)
			let game_name = tasks[0].name
			let task_id = tasks[0].task_id
			console.log('Start deploying: '+game_name+', task_id:'+task_id)

			Eth.deployContract(_config.contracts[game_name].bytecode, (address)=>{
				console.log(task_id+' - deployed')
				for(let k in _games){
					if (_games[k].task_id==task_id) {
						delete(_games[k])
						break
					}
				}
				this.add(address)

				// add bets to contract
				Api.addBets(address).then( result => {
					console.groupCollapsed('Add bets to '+address+' result:')
					console.log(result)
					console.groupEnd()
				})

				tasks.shift()

				localDB.setItem('deploy_tasks', tasks)

				setTimeout(()=>{
					this.checkTasks()
				}, 1000)
			})
		})
	}

	add(contract_id, callback){
		console.groupCollapsed('[Games] add ' + contract_id)

		_games[contract_id] = {}

		localDB.setItem('Games', _games)

		console.log('Get game balance')
		Eth.getBetsBalance(contract_id, (balance)=>{

			console.info('balance', balance)

			_games[contract_id].balance = balance
			if (!_games[contract_id].start_balance) {
				_games[contract_id].start_balance = balance
			}

			localDB.setItem('Games', _games)

			console.groupEnd()

			if (callback) callback()
		})
	}

	remove(contract_id){
		delete(_games[contract_id])
		localDB.setItem('Games', _games)
	}

	runUpdateBalance(){
		this.get(games => {
			for(let contract_id in games){
				Eth.getBetsBalance(contract_id, (balance)=>{
					_games[contract_id].balance = balance
					localDB.setItem('Games', _games)
				})
			}
		})
	}

	checkBalances(){
		console.log('checkBalances')
		Eth.getEthBalance(Eth.Wallet.get().openkey, (balance)=>{
			if (balance < 3) {
				Api.addBets(Eth.Wallet.get().openkey)
			}
		})
		// Eth.getBetsBalance(Eth.Wallet.get().openkey, (balance)=>{
		// })

		setTimeout(()=>{
			this.checkBalances()
		}, 30000)
	}

	runConfirm(){
		localDB.getItem('seeds_list', (err, seeds_list)=>{
			if (!err && seeds_list) {
				_seeds_list = seeds_list
			}

			this.get(games => {
				if (!games || !Object.keys(games).length) {
					setTimeout(()=>{
						this.runConfirm()
					}, 2*_config.confirm_timeout )
					return
				}

				for(let address in games){
					if (games[address].deploying) { continue }

					this.getLogs(address, (r)=>{
						console.log('[UPD] Games.getLogs '+address+' res:',r)

						setTimeout(()=>{
							this.runConfirm()
						}, _config.confirm_timeout )
					})
				}
			})
		})
	}


	getLogs(address, callback){
		Api.getLogs(address).then( seeds => {
			console.info('unconfirmed from server:'+seeds)
			if (seeds && seeds.length) {
				seeds.forEach( seed => {
					if (!_seeds_list[seed]) {
						_seeds_list[seed] = {
							contract:address
						}
					}
					this.sendRandom2Server(address, seed)
				})
			}
		})

		// Blockchain
		Eth.RPC.request('getLogs',[{
			'address':   address,
			'fromBlock': Eth.getCurBlock,
			'toBlock':   'latest',
		}]).then( response => {
			if(!response.result){ callback(null); return }

			response.result.forEach(item => {

				Eth.setCurBlock(item.blockNumber)

				let seed = item.data

				if (!_seeds_list[seed]) {
					_seeds_list[seed] = { contract:address }
				}

				if (!_seeds_list[seed].confirm_sended_blockchain) {
					this.addTaskSendRandom(address, seed)
				}
			})

			callback(response.result)
			return
		})
	}


	addTaskSendRandom(address, seed, callback=false, repeat_on_error=3){
		let task = new AsyncTask({
			priority: 'low',
			callback:()=>{
				return new Promise((resolve, reject) => {
					try	{
						this.sendRandom(address, seed, (ok, result)=>{
							if (ok) {
								resolve( result )
							} else {
								reject( result )
							}
						})
					} catch(e){
						reject(e)
					}
				})
			},
		})

		task.promise.then(
			result => {
				if (callback) callback(result)
			},
			// Ошибка
			e => {
				if (repeat_on_error>0) {
					repeat_on_error--
					this.addTaskSendRandom(address, seed, callback, repeat_on_error)
				}
			}
		)

		this.Queue.enqueue(task)
	}

	checkPending(address, seed, callback){
		if (_seeds_list[seed].pending) {
			callback()
		}

		if (!_pendings_list[address+'_'+seed]) {
			_pendings_list[address+'_'+seed] = 0
		}

		_pendings_list[address+'_'+seed]++

		if (_pendings_list[address+'_'+seed] > 5) {
			return
		}

		Eth.RPC.request('call', [{
			'to':   address,
			'data': '0xa7222dcd'+seed.substr(2)
		}, 'pending'],0).then( response => {

			console.log('>> Pending response:', response)

			if (!response.result || response.result.split('0').join('').length < 5) {
				_seeds_list[seed].pending = false
				return
			}

			_seeds_list[seed].pending = true
			delete( _pendings_list[address+'_'+seed] )
			callback()
		})
	}

	sendRandom2Server(address, seed){
		if (_seeds_list[seed] && _seeds_list[seed].confirm_sended_server) {
			return
		}

		this.checkPending(address, seed, ()=>{
			Eth.Wallet.getConfirmNumber(seed, address, _config.contracts.dice.abi, (confirm, PwDerivedKey)=>{

				Api.sendConfirm(seed, confirm).then(()=>{
					_seeds_list[seed].confirm_server_time   = new Date().getTime()
					_seeds_list[seed].confirm               = confirm
					_seeds_list[seed].confirm_server        = confirm
					_seeds_list[seed].confirm_sended_server = true

					localDB.setItem('seeds_list', _seeds_list)
				})
			})
		})
	}

	sendRandom(address, seed, callback){
		if (_seeds_list[seed] && _seeds_list[seed].confirm_sended_blockchain) {
			return
		}

		Eth.Wallet.getSignedTx(seed, address, _config.contracts.dice.abi, (signedTx, confirm)=>{

			console.log('getSignedTx result:', seed, confirm)

			Eth.RPC.request('sendRawTransaction', ['0x'+signedTx], 0).then( response => {
				_seeds_list[seed].confirm_blockchain_time   = new Date().getTime()
				_seeds_list[seed].confirm_sended_blockchain = true
				_seeds_list[seed].confirm                   = confirm
				_seeds_list[seed].confirm_blockchain        = confirm

				localDB.setItem('seeds_list', _seeds_list, ()=>{
					callback(!!response.result, response)
				})
			}).catch( err => {
				console.error('sendRawTransaction error:', err)
			})

		})
	}

}

export default new Games()
