from .base import DictionaryModule
from .jmdict import JMdictModule
from .handler import DictionaryUrlSchemeHandler, get_dict_module

__all__ = ['DictionaryModule', 'JMdictModule', 'DictionaryUrlSchemeHandler', 'get_dict_module']
